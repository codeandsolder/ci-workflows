// Stage one coordinated compiler update and promote only after every enrolled
// repository's real PR checks pass. Run with the fleet GitHub App's gh auth.
// No upstream issue lists, label heuristics, bypasses, or forced merges.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { latestCandidate, nightlyDate, readPin, requireAge } from '../.github/actions/resolve-rust-toolchain/select.mjs';

const FILE = 'rust-toolchain.toml';
const COORDINATOR = 'codeandsolder/ci-workflows';
const WEEK = 7 * 86_400_000;
const PREFIX = 'automation/fleet-nightly-';

export function replacePin(text, from, to) {
  nightlyDate(from);
  nightlyDate(to);
  if (readPin(text) !== from) throw Error('manifest does not contain expected pin');
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^([ \\t]*channel[ \\t]*=[ \\t]*["\\\'])' + escaped + '(["\\\'][ \\t]*(?:#.*)?)$', 'gm');
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) throw Error('ambiguous channel declaration');
  const result = text.replace(regex, '$1' + to + '$2');
  if (readPin(result) !== to) throw Error('channel replacement failed');
  return result;
}

export function validateCohort(config) {
  const repos = config.repositories;
  if (!Array.isArray(repos) || repos.length < 2 ||
      repos.at(-1)?.name !== COORDINATOR ||
      new Set(repos.map(repo => repo.name)).size !== repos.length) {
    throw Error('cohort must have unique repositories and coordinator last');
  }
  for (const repo of repos) {
    if (!/^codeandsolder\/[A-Za-z0-9_.-]+$/.test(repo.name) ||
        !Array.isArray(repo.requiredChecks) || !repo.requiredChecks.length ||
        repo.requiredChecks.some(pair => !Array.isArray(pair) || pair.length !== 2 ||
          pair.some(name => typeof name !== 'string' || !name))) {
      throw Error('invalid cohort repository or required check: ' + repo.name);
    }
  }
  return repos;
}

export function checkBlockers(checks, required) {
  const blockers = [];
  for (const [workflow, name] of required) {
    const matches = checks.filter(check => check.workflowName === workflow && check.name === name);
    if (!matches.length || matches.some(check => check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS')) {
      blockers.push('required check not successful: ' + workflow + ' / ' + name);
    }
  }
  for (const check of checks) {
    if ('status' in check) {
      if (check.status !== 'COMPLETED' ||
          !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.conclusion)) {
        blockers.push('check not successful: ' + (check.workflowName || '') + ' / ' + check.name);
      }
    } else if (check.state !== 'SUCCESS') {
      blockers.push('status not successful: ' + check.context);
    }
  }
  return [...new Set(blockers)];
}

export function promotionBlockers(states) {
  return states.flatMap(state => state.blockers.map(reason => state.name + ': ' + reason));
}

function gh(args, input) {
  return execFileSync('gh', args, {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024, timeout: 60_000, stdio: ['pipe','pipe','pipe']
  }).trim();
}

function api(path, method = 'GET', body) {
  const args = ['api', '--method', method, path];
  if (body !== undefined) args.push('--input', '-');
  return JSON.parse(gh(args, body));
}

function maybeApi(path) {
  try { return api(path); }
  catch (error) {
    if (String(error.stderr).includes('HTTP 404')) return null;
    throw error;
  }
}

const endpoint = (repo, suffix) => 'repos/' + repo + (suffix ? '/' + suffix : '');
const branchOf = channel => PREFIX + channel.slice(8);
const markerOf = channel => '<!-- fleet-nightly-promotion:' + channel + ' -->';
const readContent = content => Buffer.from(content.content, 'base64').toString('utf8');

function manifest(repo, ref) {
  const content = api(endpoint(repo, 'contents/' + FILE + '?ref=' + encodeURIComponent(ref)));
  const text = readContent(content);
  return { sha: content.sha, text, channel: readPin(text) };
}

function snapshot(repo) {
  const info = api(endpoint(repo, ''));
  if (info.archived || info.disabled) throw Error('inactive cohort repository: ' + repo);
  const base = info.default_branch;
  const head = api(endpoint(repo, 'branches/' + encodeURIComponent(base))).commit.sha;
  return { repo, base, head, file: manifest(repo, head) };
}

function prFor(repo, channel) {
  const list = JSON.parse(gh(['pr','list','--repo',repo,'--head',branchOf(channel),'--state','all',
    '--limit','10','--json','number']));
  if (list.length > 1) throw Error('ambiguous candidate PR: ' + repo);
  if (!list.length) return null;
  return JSON.parse(gh(['pr','view','--repo',repo,String(list[0].number),'--json',
    'number,title,body,url,state,isDraft,headRefName,headRefOid,baseRefName,mergeStateStatus,statusCheckRollup,files']));
}

function verifyPR(current, pr, channel) {
  if (pr.headRefName !== branchOf(channel) || pr.baseRefName !== current.base ||
      !pr.body.includes(markerOf(channel))) {
    throw Error('unexpected candidate PR identity: ' + current.repo);
  }
  if (pr.state === 'MERGED' && current.file.channel === channel) return;
  if (pr.state !== 'OPEN') throw Error('candidate PR is not open: ' + current.repo);
  if (pr.files.length !== 1 || pr.files[0].path !== FILE) {
    throw Error('candidate PR must change only the toolchain manifest: ' + current.repo);
  }
  const proposed = manifest(current.repo, pr.headRefOid);
  if (proposed.text !== replacePin(current.file.text, current.file.channel, channel)) {
    throw Error('candidate contains unexpected manifest changes: ' + current.repo);
  }
}

function verifyState(entry, channel) {
  const current = snapshot(entry.name);
  const pr = prFor(entry.name, channel);
  if (!pr) return { name: entry.name, blockers: ['no candidate PR'], current };
  verifyPR(current, pr, channel);
  if (pr.state === 'MERGED') return { name: entry.name, blockers: [], merged: true, current, pr };
  const comparison = api(endpoint(entry.name, 'compare/' + current.head + '...' + pr.headRefOid));
  const blockers = checkBlockers(pr.statusCheckRollup, entry.requiredChecks);
  if (comparison.behind_by !== 0) blockers.push('candidate branch is behind the current base; refresh and retest');
  if (pr.mergeStateStatus === 'DIRTY') blockers.push('merge conflict');
  return { name: entry.name, blockers, current, pr };
}

function createCandidate(current, channel) {
  const repo = current.repo;
  const branch = branchOf(channel);
  const path = endpoint(repo, 'git/ref/heads/' + branch);
  let existing = maybeApi(path);
  if (!existing) {
    existing = api(endpoint(repo, 'git/refs'), 'POST', { ref: 'refs/heads/' + branch, sha: current.head });
  }
  const proposed = replacePin(current.file.text, current.file.channel, channel);
  if (existing.object.sha === current.head) {
    api(endpoint(repo, 'contents/' + FILE), 'PUT', {
      message: 'Promote fleet compiler to ' + channel,
      content: Buffer.from(proposed).toString('base64'),
      sha: current.file.sha, branch
    });
  } else {
    // Resume only an exact interrupted pin-only change.
    const diff = api(endpoint(repo, 'compare/' + current.head + '...' + existing.object.sha));
    if (diff.behind_by !== 0 || diff.files.length !== 1 || diff.files[0].filename !== FILE ||
        manifest(repo, existing.object.sha).text !== proposed) {
      throw Error('existing rollout branch requires review: ' + repo);
    }
  }
  console.log(gh(['pr','create','--repo',repo,'--head',branch,'--base',current.base,'--draft',
    '--title','Fleet compiler: ' + channel,
    '--body',markerOf(channel) + '\n\nCoordinated dated nightly promotion. All enrolled repositories must pass their real PR validation before the coordinator merges any change.']));
}

async function run(args) {
  const [mode, channel, ...flags] = args;
  const apply = flags.length === 1 && flags[0] === '--apply';
  if (!['select','prepare','status','promote'].includes(mode) ||
      (mode === 'select' ? args.length !== 1 : !channel || (flags.length && !apply))) {
    throw Error('usage: nightly-cohort.mjs select | prepare CHANNEL [--apply] | status CHANNEL | promote CHANNEL [--apply]');
  }
  const config = JSON.parse(readFileSync(new URL('../nightly-cohort.json', import.meta.url),'utf8'));
  const repos = validateCohort(config);
  const central = snapshot(COORDINATOR);
  if (mode === 'select') {
    const last = api(endpoint(COORDINATOR, 'commits?path=' + FILE + '&sha=' + central.head + '&per_page=1'))[0];
    const lastChange = Date.parse(last?.commit?.committer?.date);
    if (!Number.isFinite(lastChange)) throw Error('cannot establish last promotion time');
    if (Date.now() - lastChange >= WEEK) console.log(await latestCandidate(central.file.channel) || '');
    return;
  }
  await requireAge(channel);
  if (nightlyDate(channel) < nightlyDate(central.file.channel)) throw Error('candidate precedes approved fleet compiler');
  if (mode === 'prepare' || (mode === 'promote' && channel !== central.file.channel)) {
    if (nightlyDate(channel) < nightlyDate(central.file.channel) + WEEK) {
      throw Error('candidate must be at least a week newer than the central pin');
    }
    const last = api(endpoint(COORDINATOR, 'commits?path=' + FILE + '&sha=' + central.head + '&per_page=1'))[0];
    const lastChange = Date.parse(last?.commit?.committer?.date);
    if (!Number.isFinite(lastChange) || Date.now() - lastChange < WEEK) throw Error('weekly promotion cadence has not elapsed');
  }
  if (mode === 'prepare') {
    // Inspect all repos before performing any mutation.
    const states = repos.map(entry => {
      const current = snapshot(entry.name);
      const pr = prFor(entry.name, channel);
      const open = JSON.parse(gh(['pr','list','--repo',entry.name,'--state','open','--limit','1000','--json','headRefName']));
      if (open.length === 1000) throw Error('too many open PRs to verify unique candidate: ' + entry.name);
      if (open.some(p => p.headRefName.startsWith(PREFIX) && p.headRefName !== branchOf(channel))) {
        throw Error('another fleet compiler candidate is active: ' + entry.name);
      }
      if (pr) verifyPR(current, pr, channel);
      if (current.file.channel !== central.file.channel && !(pr?.state === 'MERGED' && current.file.channel === channel)) {
        throw Error('repository not synchronized to approved pin: ' + entry.name);
      }
      return { current, pr };
    });
    for (const state of states) {
      if (!state.pr) {
        console.log(state.current.repo + ': stage ' + channel);
        if (apply) createCandidate(state.current, channel);
      } else {
        console.log(state.current.repo + ': ' + state.pr.url + ' (' + state.pr.state + ')');
        if (apply && state.pr.state === 'OPEN') {
          const diff = api(endpoint(state.current.repo,'compare/' + state.current.head + '...' + state.pr.headRefOid));
          if (diff.behind_by !== 0) gh(['pr','update-branch','--repo',state.current.repo,String(state.pr.number)]);
        }
      }
    }
    return;
  }
  const states = repos.map(entry => verifyState(entry, channel));
  for (const state of states) {
    if (!state.merged && state.current.file.channel !== central.file.channel) {
      state.blockers.push('repository is not on the approved cohort baseline');
    }
  }
  for (const state of states) {
    console.log(JSON.stringify({ repo: state.name, pr: state.pr?.url, merged: !!state.merged, blockers: state.blockers }));
  }
  const blockers = promotionBlockers(states);
  if (blockers.length) throw Error('promotion held:\n' + blockers.join('\n'));
  if (mode === 'status' || !apply) return;
  // Re-check every head immediately before mutation. Coordinator merges last.
  for (const entry of repos) {
    const state = verifyState(entry, channel);
    if (state.merged) continue;
    if (state.blockers.length) throw Error('candidate changed while promoting: ' + entry.name);
    if (state.pr.isDraft) gh(['pr','ready','--repo',entry.name,String(state.pr.number)]);
    const ready = verifyState(entry, channel);
    if (ready.blockers.length || ready.pr.headRefOid !== state.pr.headRefOid) {
      throw Error('ready-for-review checks changed: ' + entry.name);
    }
    gh(['pr','merge','--repo',entry.name,String(ready.pr.number),'--squash',
      '--match-head-commit',ready.pr.headRefOid]);
    if (snapshot(entry.name).file.channel !== channel) throw Error('merge was not completed: ' + entry.name);
    console.log(entry.name + ': promoted ' + channel);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await run(process.argv.slice(2)); }
  catch (error) {
    console.error(error.message);
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  }
}
