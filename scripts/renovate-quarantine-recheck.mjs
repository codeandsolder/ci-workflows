#!/usr/bin/env node
// Rerun a completed Renovate CI job only when its *sole* failure is an expired
// Cargo publication-age hold. GitHub Actions performs the real quarantine again.
import { isContributionOnly, isMaintainedRepo } from './fleet-scope.mjs';
import { execFileSync } from 'node:child_process';
import { decide as runPolicy } from '../policy-wasm/bridge.mjs';

export const BOT_LOGINS = new Set(['renovate[bot]', 'renovate']);
const DEFAULT_GRACE_MS = 15 * 60_000;

// Native code only captures GitHub data and performs authorized reruns. The
// read-only Rust/WASI guest makes every age, check and job eligibility choice.
export function parseQuarantineHold(log, module) {
  return runPolicy('renovate-recheck', {op: 'hold', log}, module);
}

export function classifyJob(job, prHead, module) {
  return runPolicy('renovate-recheck', {op: 'job', job, pr_head: prHead}, module);
}

export function decide(hold, now, graceMs = DEFAULT_GRACE_MS, module) {
  return runPolicy('renovate-recheck', {
    op: 'eligibility', hold, now_ms: now, grace_ms: graceMs,
  }, module);
}

export function eligibleChecks(checks, module) {
  return runPolicy('renovate-recheck', {op: 'checks', checks}, module);
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
