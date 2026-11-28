import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const prefix = 'rust-dependency-health-';

async function gh(args) {
  const {stdout} = await exec('gh', args, {timeout: 90_000, maxBuffer: 64 * 1024 * 1024});
  return stdout;
}
const json = async args => JSON.parse(await gh(args));

// The private-repository action prints the exact results.json to the job
// log. Use the report boundary, not a grep for arbitrary "current" fields.
export function logReports(log) {
  const pending = new Map(), reports = [];
  for (const line of log.split(/\r?\n/)) {
    const match = /^([^\t]+)\t([^\t]+)\t\d{4}-\d\d-\d\dT\S+ (.*)$/.exec(line);
    if (!match) continue;
    const [, job, step, content] = match;
    const key = job + '\t' + step;
    if (/^(?:\/|[A-Za-z]:[\\/]).*[\\/]results\.json$/.test(content)) {
      pending.set(key, []);
      continue;
    }
    const lines = pending.get(key);
    if (!lines) continue;
    if (!lines.length && content !== '{') {
      pending.delete(key);
      continue;
    }
    lines.push(content);
    if (content !== '}') continue;
    pending.delete(key);
    try { reports.push(JSON.parse(lines.join('\n'))); } catch { /* malformed is not a clean report */ }
  }
  return reports;
}

export function normalizeReport(report, source) {
  if (typeof report?.directory !== 'string' || !report.directory || typeof report.anoint !== 'object' || report.anoint === null) return null;
  const scan = report.anoint;
  const valid = scan.failed === false && Number.isInteger(scan.packages) && scan.packages > 0 &&
    typeof scan.version === 'string' && Array.isArray(scan.findings) &&
    scan.findings.every(f => f && ['kind','current','recommended','impact'].every(k => typeof f[k] === 'string'));
  return {
    directory: report.directory, source, available: valid,
    packages: valid ? scan.packages : null,
    version: valid ? scan.version : null,
    findings: valid ? scan.findings : null,
    error: valid ? null : report.anointError || report.anointStderr || 'Unavailable or invalid scanner report',
    policyTriggered: valid ? scan.policyTriggered === true : null,
  };
}

export function summarizeReports(reports) {
  const workspaces = new Map();
  for (const report of reports.filter(Boolean)) {
    const previous = workspaces.get(report.directory);
    if (!previous || (!previous.available && report.available)) workspaces.set(report.directory, report);
  }
  const selected = [...workspaces.values()];
  const usable = selected.filter(r => r.available);
  const findings = usable.flatMap(r => r.findings);
  const distinct = new Map();
  const priority = {High:3,Medium:2,Low:1};
  for (const f of findings) {
    const key = JSON.stringify([f.kind,f.current,f.recommended]);
    const previous = distinct.get(key);
    if (!previous || priority[f.impact] > priority[previous.impact]) distinct.set(key,f);
  }
  return {
    reports: selected,
    packages: usable.length ? usable.reduce((n,r)=>n+r.packages,0) : null,
    raw: usable.length ? findings.length : null,
    unique: usable.length ? distinct.size : null,
    high: usable.length ? [...distinct.values()].filter(f => f.impact === 'High').length : null,
    overlaps: usable.length ? [...distinct.values()].filter(f => f.kind === 'CapabilityOverlap') : null,
    advisoryOverlaps: usable.length ? [...distinct.values()].filter(f => f.kind === 'AdvisoryOverlap') : null,
    allRetrievedReportsAvailable: usable.length > 0 && usable.length === selected.length,
  };
}

async function resultFiles(path) {
  const entries = await readdir(path, {withFileTypes:true});
  const all = await Promise.all(entries.map(e => {
    const child = join(path,e.name);
    if (e.isDirectory()) return resultFiles(child);
    return e.isFile() && e.name === 'results.json' ? [child] : [];
  }));
  return all.flat();
}

function candidate(run) {
  return run.status === 'completed' &&
    /(?:^CI$|Rust|Dependency consolidation|Dependency gate|Solver CI|Repository checks|Build Salad)/i.test(run.name || '') &&
    !/(?:duplicate|source quality|quarantine|release-age|publish|license review)/i.test(run.name || '');
}

// Keep all workflow runs at the same commit together. Do not mix reports
// from different source revisions and call that a current workspace graph.
export function groupRuns(runs, artifacts, branch, limit=5) {
  const byRun = new Map();
  for (const run of runs.filter(candidate)) byRun.set(run.id, run);
  for (const artifact of artifacts) {
    if (artifact.expired || !artifact.name.startsWith(prefix) || !artifact.workflow_run) continue;
    const run = artifact.workflow_run;
    if (!byRun.has(run.id)) byRun.set(run.id, {...run, created_at:artifact.created_at, status:'completed'});
  }
  const groups = new Map();
  const ordered = [...byRun.values()].filter(r => typeof r.head_sha === 'string' && (branch === null || r.head_branch === branch))
    .sort((a,b)=>b.created_at.localeCompare(a.created_at));
  for (const run of ordered) {
    const key = run.head_branch + '\0' + run.head_sha;
    if (!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(run);
  }
  return [...groups.values()].slice(0,limit);
}

async function readRun(fullName, run, artifacts, output, privateRepo, errors) {
  const source = {runId:run.id, branch:run.head_branch, sha:run.head_sha, createdAt:run.created_at};
  let reports = [];
  if (artifacts.some(a => !a.expired && a.name.startsWith(prefix) && a.workflow_run?.id === run.id)) {
    const temp = await mkdtemp(join(output,'.download-'));
    try {
      await gh(['run','download',String(run.id),'-R',fullName,'-D',temp,'-p',prefix+'*']);
      for (const path of await resultFiles(temp)) {
        try {
          const report = normalizeReport(JSON.parse(await readFile(path,'utf8')), {...source, type:'artifact'});
          if (report) reports.push(report);
        } catch (e) { errors.push('Invalid result in artifact '+run.id+': '+e.message); }
      }
    } catch (e) { errors.push('Artifact '+run.id+': '+e.message); }
    finally { await rm(temp,{recursive:true,force:true}); }
  }
  // Old artifacts may contain only audit and unused findings. Missing
  // anoint output is not evidence that the workspace has no recommendations.
  if (!privateRepo && reports.some(r=>r.available)) return reports;
  try {
    const {jobs} = await json(['run','view',String(run.id),'-R',fullName,'--json','jobs']);
    for (const job of jobs) {
      if (!job.steps?.some(step => step.conclusion !== 'skipped' &&
        /(?:Enforce dependency consolidation|Report dependency advisories|Collect mandatory dependency scan)/i.test(step.name))) continue;
      const log = await gh(['run','view',String(run.id),'-R',fullName,'--job',String(job.databaseId),'--log']);
      for (const raw of logReports(log)) {
        const report = normalizeReport(raw,{...source,type:'log',jobId:job.databaseId});
        if (report) reports.push(report);
      }
    }
  } catch (e) { errors.push('Log '+run.id+': '+e.message); }
  return reports;
}

async function collect(owner, repo, output) {
  const fullName = owner+'/'+repo.name;
  const branch = repo.defaultBranchRef?.name;
  const errors = [];
  const base = 'repos/'+fullName+'/actions/';
  const inventory = {repo:repo.name, defaultBranch:branch, private:repo.isPrivate};
  try {
    const artifacts = (await json(['api',base+'artifacts?per_page=100'])).artifacts;
    const defaults = (await json(['api',base+'runs?branch='+encodeURIComponent(branch)+'&per_page=30'])).workflow_runs;
    const groups = groupRuns(defaults,artifacts,branch);
    let unavailable = [];
    async function tryGroups(candidates, coverage) {
      for (const group of candidates) {
        const reports = [];
        for (const run of group) reports.push(...await readRun(fullName,run,artifacts,output,repo.isPrivate,errors));
        const summary = summarizeReports(reports);
        if (summary.packages !== null) return {...inventory,coverage,branch:group[0].head_branch,
          sha:group[0].head_sha,latestCandidateSha:groups[0]?.[0].head_sha ?? null,...summary,errors};
        unavailable.push(...reports);
      }
      return null;
    }
    const current = await tryGroups(groups,'default');
    if (current) return current;
    const prs = (await json(['api',base+'runs?event=pull_request&per_page=30'])).workflow_runs;
    const fallback = await tryGroups(groupRuns(prs.filter(run=>run.head_branch!==branch),artifacts.filter(a=>a.workflow_run?.head_branch!==branch),null),'pr');
    if (fallback) return fallback;
    return {...inventory,coverage:'unavailable',...summarizeReports(unavailable),errors};
  } catch (e) {
    return {...inventory,coverage:'unavailable',...summarizeReports([]),errors:[...errors,e.message]};
  }
}

async function main() {
  const [owner,destination,...names] = process.argv.slice(2);
  if (!owner || !destination) throw Error('usage: node scripts/fleet-dependency-report.mjs OWNER OUTPUT_DIRECTORY [REPOSITORY ...]');
  const output = resolve(destination);
  await mkdir(output,{recursive:true,mode:0o700});
  const repos = (await json(['repo','list',owner,'--limit','1000','--json','name,defaultBranchRef,primaryLanguage,isArchived,isPrivate']))
    .filter(r => !r.isArchived && r.defaultBranchRef && (names.length ? names.includes(r.name) : r.primaryLanguage?.name === 'Rust'));
  if (names.some(name=>!repos.some(r=>r.name===name))) throw Error('Requested repository missing from active inventory');
  const results = [];
  let next = 0;
  await Promise.all(Array.from({length:Math.min(3,repos.length)},async()=>{
    while (next < repos.length) {
      const repo = repos[next++];
      const result = await collect(owner,repo,output);
      results.push(result);
      console.log(repo.name+' '+result.coverage+' '+(result.unique ?? 'unavailable'));
    }
  }));
  results.sort((a,b)=>a.repo.localeCompare(b.repo));
  await writeFile(join(output,'reports.json'),JSON.stringify(results,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({total:results.length,default:results.filter(r=>r.coverage==='default').length,pr:results.filter(r=>r.coverage==='pr').length,unavailable:results.filter(r=>r.coverage==='unavailable').length}));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
