#!/usr/bin/env node
// Rerun a completed Renovate CI job only when its *sole* failure is an expired
// Cargo publication-age hold. GitHub Actions performs the real quarantine again.
import { isContributionOnly, isMaintainedRepo } from './fleet-scope.mjs';
import { execFileSync } from 'node:child_process';

export const BOT_LOGINS = new Set(['renovate[bot]', 'renovate']);
const AGE_HEADER = 'Cargo release-age quarantine is still active:';
const PUBLICATION = /^-\s+([a-zA-Z0-9_-]+)\s+(\S+): published (\S+), younger than (\d+)h$/;
const QUARANTINE_STEP = /quarantine|release.age/i;
const ANSI = /\x1b\[[0-9;]*m/g;
const DEFAULT_GRACE_MS = 15 * 60_000;

export function parseQuarantineHold(log) {
  const lines = log.replace(ANSI, '').split(/\r?\n/);
  let markerCount = 0;
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(AGE_HEADER)) continue;
    markerCount++;
    const entries = [];
    for (let j = i + 1; j < lines.length; j++) {
      // CI log timestamps prefix the actual stderr messages.
      const body = lines[j].replace(/^\d{4}-\d\d-\d\dT\S+?\s+/, '').trim();
      if (!body.startsWith('- ')) break;
      const m = PUBLICATION.exec(body);
      if (!m) return { eligible: false, reason: 'unknown-quarantine-reason' };
      const published = Date.parse(m[3]);
      const hours = Number(m[4]);
      if (!Number.isFinite(published) || !Number.isSafeInteger(hours) || hours < 72) {
        return { eligible: false, reason: 'invalid-age-metadata' };
      }
      entries.push({ name: m[1], version: m[2], publishedAt: m[3],
        eligibleAt: published + hours * 3_600_000, hours });
    }
    if (entries.length === 0) return { eligible: false, reason: 'no-crates' };
    blocks.push(...entries);
  }
  if (markerCount === 0) return { eligible: false, reason: 'not-a-quarantine-hold' };
  const eligibleAt = Math.max(...blocks.map(e => e.eligibleAt));
  if (!Number.isFinite(eligibleAt)) return { eligible: false, reason: 'invalid-eligibility' };
  return { eligible: true, blockers: blocks, eligibleAt };
}

export function classifyJob(job, prHead) {
  if (job.status !== 'completed' || job.conclusion !== 'failure' || job.head_sha !== prHead) {
    return 'stale-or-not-failed';
  }
  // Prevent a failing rerun of a permanently broken PR from looping hourly.
  if (job.run_attempt !== 1) return 'already-retried';
  const failures = (job.steps || []).filter(s => s.conclusion === 'failure');
  if (!failures.length || failures.some(s => !QUARANTINE_STEP.test(s.name))) {
    return 'other-job-failure';
  }
  return null;
}

export function decide(hold, now, graceMs = DEFAULT_GRACE_MS) {
  if (!hold.eligible) return hold.reason;
  return now >= hold.eligibleAt + graceMs ? null : 'release-too-young';
}

export function eligibleChecks(checks) {
  // Names are caller-controlled, and a strict gate can fail for other reasons.
  // Inspect actual failed job steps and logs before deciding to retry.
  if (checks.some(c => c.status !== 'completed')) return null;
  const terminalPass = new Set(['success', 'skipped', 'neutral']);
  const failures = checks.filter(c => !terminalPass.has(c.conclusion));
  if (!failures.length || failures.some(c =>
      c.app?.slug !== 'github-actions' || c.conclusion !== 'failure')) return null;
  return failures;
}

function api(path, options = {}) {
  const args = ['api', path];
  if (options.method) args.splice(1, 0, '-X', options.method);
  const raw = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    timeout: 45_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return options.raw ? raw : options.method ? true : JSON.parse(raw);
}

function pages(endpoint) {
  const all = [];
  for (let page = 1; ; page++) {
    if (page > 100) throw Error('unexpected API pagination depth: ' + endpoint);
    const payload = api(endpoint + (endpoint.includes('?') ? '&' : '?') +
      'per_page=100&page=' + page);
    const values = Array.isArray(payload) ? payload :
      payload.repositories ?? payload.check_runs ?? [];
    all.push(...values);
    if (values.length < 100) return all;
  }
}

function emit(type, fields = {}) {
  process.stdout.write(JSON.stringify({ type, ...fields }) + '\n');
}

function optionsOf(args) {
  const options = { apply: false, repo: null, max: 10, graceMs: DEFAULT_GRACE_MS };
  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--repo=')) options.repo = arg.slice(7);
    else if (arg.startsWith('--max=')) options.max = Number(arg.slice(6));
    else if (arg.startsWith('--grace-minutes=')) options.graceMs = Number(arg.slice(16)) * 60_000;
    else if (arg === '--help') {
      console.log('Usage: node scripts/renovate-quarantine-recheck.mjs [--apply] [--repo=owner/name] [--max=10] [--grace-minutes=15]');
      process.exit(0);
    } else throw Error('unknown argument ' + arg);
  }
  if (!Number.isSafeInteger(options.max) || options.max < 1 || options.max > 100 ||
      !Number.isFinite(options.graceMs) || options.graceMs < 0 ||
      (options.repo && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(options.repo))) {
    throw Error('invalid options');
  }
  return options;
}

async function main() {
  const opts = optionsOf(process.argv.slice(2));
  const now = Date.now();
  if (opts.repo && isContributionOnly(opts.repo)) throw Error('Contribution-only fork: ' + opts.repo);
  const repos = opts.repo
    ? [{ full_name: opts.repo, archived: false }]
    : pages('installation/repositories').filter(isMaintainedRepo);
  let actions = 0, candidates = 0, failures = 0;
  for (const repo of repos) {
    const full = repo.full_name;
    let prs;
    try {
      prs = pages('repos/' + full + '/pulls?state=open');
    } catch (err) {
      failures++;
      emit('api-error', { repo: full, stage: 'pulls', message: err.message.slice(0, 250) });
      continue;
    }
    for (const pr of prs.filter(p => BOT_LOGINS.has(p.user?.login))) {
      if (actions >= opts.max) break;
      const head = pr.head.sha;
      let checks;
      try {
        checks = pages('repos/' + full + '/commits/' + head + '/check-runs');
      } catch (err) {
        failures++;
        emit('api-error', { repo: full, pr: pr.number, stage: 'checks',
          message: err.message.slice(0, 250) });
        continue;
      }
      const ageChecks = eligibleChecks(checks);
      if (!ageChecks) continue;
      // A PR is eligible only if *every* currently unsuccessful check is a
      // verified age-only failure and every reported age has elapsed. This
      // prevents re-running one of two strict jobs while the other has a real
      // compile/lint error, and supports arbitrary caller-facing job names.
      const candidatesForPr = [];
      let blocked = false;
      for (const check of ageChecks) {
        const jobId = check.id;
        try {
          const job = api('repos/' + full + '/actions/jobs/' + jobId);
          const jobReason = classifyJob(job, head);
          if (jobReason) {
            emit('skip', { repo: full, pr: pr.number, jobId, reason: jobReason });
            blocked = true;
            break;
          }
          const hold = parseQuarantineHold(api('repos/' + full + '/actions/jobs/' +
            jobId + '/logs', { raw: true }));
          const reason = decide(hold, now, opts.graceMs);
          candidates++;
          if (reason) {
            emit('skip', { repo: full, pr: pr.number, jobId, reason,
              eligibleAt: hold.eligibleAt ? new Date(hold.eligibleAt + opts.graceMs).toISOString() : null });
            blocked = true;
            break;
          }
          candidatesForPr.push({ job, jobId, hold });
        } catch (err) {
          failures++;
          blocked = true;
          emit('api-error', { repo: full, pr: pr.number, jobId, stage: 'job',
            message: err.message.slice(0, 250) });
          break;
        }
      }
      if (blocked || candidatesForPr.length !== ageChecks.length) continue;
      try {
        const live = api('repos/' + full + '/pulls/' + pr.number);
        if (live.state !== 'open' || live.head.sha !== head) continue;
        const currentChecks = pages('repos/' + full + '/commits/' + head + '/check-runs');
        const currentFailures = eligibleChecks(currentChecks);
        if (!currentFailures || currentFailures.length !== ageChecks.length ||
            ageChecks.some(c => !currentFailures.some(a => a.id === c.id))) continue;
        // Validate every original job again before the first mutation.
        if (candidatesForPr.some(({ jobId }) =>
          classifyJob(api('repos/' + full + '/actions/jobs/' + jobId), head))) continue;
        // Rerun one job when it is the only age-held job in its workflow,
        // otherwise rerun only the failed jobs of that workflow together.
        const groups = new Map();
        for (const candidate of candidatesForPr) {
          const group = groups.get(candidate.job.run_id) || [];
          group.push(candidate);
          groups.set(candidate.job.run_id, group);
        }
        for (const [runId, group] of groups) {
          if (actions >= opts.max) break;
          const current = api('repos/' + full + '/pulls/' + pr.number);
          if (current.state !== 'open' || current.head.sha !== head) break;
          const jobIds = group.map(c => c.jobId);
          const payload = { repo: full, pr: pr.number, jobId: jobIds[0], jobIds, head, runId,
            blockingCrates: [...new Set(group.flatMap(c => c.hold.blockers.map(b => b.name + ' ' + b.version)))],
            eligibleAt: new Date(Math.max(...group.map(c => c.hold.eligibleAt)) + opts.graceMs).toISOString() };
          if (!opts.apply) emit('dry-run', payload);
          else {
            const endpoint = group.length === 1
              ? '/actions/jobs/' + jobIds[0] + '/rerun'
              : '/actions/runs/' + runId + '/rerun-failed-jobs';
            api('repos/' + full + endpoint, { method: 'POST' });
            emit('rerun', payload);
          }
          actions++;
        }
      } catch (err) {
        failures++;
        emit('api-error', { repo: full, pr: pr.number, stage: 'recheck',
          message: err.message.slice(0, 250) });
      }
    }
    if (actions >= opts.max) break;
  }
  emit('summary', { repos: repos.length, candidates, actions, failures, apply: opts.apply });
  if (failures) process.exitCode = 1;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch(err => { emit('fatal', { message: err.message.slice(0, 300) }); process.exitCode = 1; });
}
