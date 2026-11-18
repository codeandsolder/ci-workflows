#!/usr/bin/env node
// Fleet-wide stale pull-request workflow cancellation.
// Runs outside Actions so it can retire blocked jobs before they get a runner.
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const ACTIVE_STATUSES = Object.freeze([
  'queued', 'pending', 'in_progress', 'waiting',
]);

const ACCEPT = 'application/vnd.github+json';
const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export class GitHubHttpError extends Error {
  constructor(status, method, path, body) {
    super(method + ' ' + path + ': HTTP ' + status + ': ' + body);
    this.status = status;
  }
}

export class GitHubApi {
  constructor(token, transport = globalThis.fetch) {
    if (!token) throw new Error('GitHub App installation token is required');
    this.token = token;
    this.transport = transport;
  }

  async request(method, path) {
    const url = API_ROOT + path;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.transport(url, {
        method,
        headers: {
          Accept: ACCEPT,
          Authorization: 'Bearer ' + this.token,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'codeandsolder-ci-workflows-fleet-guard',
        },
        signal: AbortSignal.timeout(25_000),
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          await sleep(350 * 2 ** attempt);
          continue;
        }
      }
      if (response.headers.get('x-ratelimit-remaining') !== null &&
          Number(response.headers.get('x-ratelimit-remaining')) < 100) {
        throw new Error('GitHub API rate budget is low; deferring cleanup');
      }
      if (!response.ok) {
        const body = (await response.text()).slice(0, 350);
        throw new GitHubHttpError(response.status, method, path, body);
      }
      if (response.status === 204 || response.status === 202) return null;
      return response.json();
    }
    throw new Error('Exhausted retries for ' + method + ' ' + path);
  }

  async pages(path, key) {
    const items = [];
    for (let page = 1;; page++) {
      const suffix = (path.includes('?') ? '&' : '?') + 'per_page=100&page=' + page;
      const response = await this.request('GET', path + suffix);
      const batch = key ? response[key] : response;
      if (!Array.isArray(batch)) {
        throw new Error('Expected array at ' + path + ' page ' + page);
      }
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  async repositories() {
    return this.pages('/installation/repositories', 'repositories');
  }

  async runs(repo, status) {
    return this.pages('/repos/' + repo + '/actions/runs?status=' + status, 'workflow_runs');
  }

  async pulls(repo) {
    return this.pages('/repos/' + repo + '/pulls?state=open');
  }

  async pull(repo, number) {
    return this.request('GET', '/repos/' + repo + '/pulls/' + number);
  }

  async run(repo, id) {
    return this.request('GET', '/repos/' + repo + '/actions/runs/' + id);
  }

  async commit(repo, sha) {
    return this.request('GET', '/repos/' + repo + '/commits/' + sha);
  }

  async cancel(repo, id) {
    return this.request('POST', '/repos/' + repo + '/actions/runs/' + id + '/cancel');
  }
}

export function eligibleRepository(repo, options, now = Date.now()) {
  if (repo.archived || repo.disabled || repo.owner?.login?.toLowerCase() !== options.owner.toLowerCase()) {
    return false;
  }
  if (options.repos.length > 0) return options.repos.includes(repo.full_name);
  if (options.all) return true;
  const lastPush = Date.parse(repo.pushed_at);
  return Number.isFinite(lastPush) && now - lastPush <= options.hours * 3_600_000;
}

// GitHub's run.pull_requests[].head.sha is dynamically rehydrated from the
// *current* PR and is NOT the historical head of that workflow run.
// Always use the immutable run.head_sha for supersession decisions.
export function candidateForRun(run, openPulls) {
  if (run.event !== 'pull_request' || !ACTIVE_STATUSES.includes(run.status)) return null;
  const numbers = [...new Set((run.pull_requests || [])
    .map((pr) => pr.number).filter(Number.isInteger))];
  // Unlinked PR runs may be forks or ambiguous branches. Never guess an owner.
  if (numbers.length === 0) return null;
  const linked = numbers.map((number) => openPulls.get(number));
  if (linked.some((pr) => !pr || pr.state !== 'open')) return null;
  if (!run.head_sha) return null;
  for (const pr of linked) {
    if (run.head_sha === pr.head.sha ||
        (pr.merge_commit_sha && run.head_sha === pr.merge_commit_sha)) {
      return null;
    }
  }
  return { id: run.id, sha: run.head_sha, numbers, name: run.name, status: run.status };
}

export async function confirmAndCancel(api, repo, candidate, apply) {
  // Live revalidation avoids stale list snapshots when PRs change during scan.
  const run = await api.run(repo, candidate.id);
  if (run.id !== candidate.id || run.head_sha !== candidate.sha ||
      run.event !== 'pull_request' || !ACTIVE_STATUSES.includes(run.status)) {
    return 'no-longer-eligible';
  }
  const runNumbers = new Set((run.pull_requests || []).map((pr) => pr.number));
  if (runNumbers.size !== candidate.numbers.length ||
      candidate.numbers.some((number) => !runNumbers.has(number))) {
    return 'changed-associations';
  }
  const freshPulls = [];
  for (const number of candidate.numbers) {
    const pr = await api.pull(repo, number);
    if (pr.state !== 'open') return 'closed-pr-preserved';
    if (run.head_sha === pr.head.sha ||
        (pr.merge_commit_sha && run.head_sha === pr.merge_commit_sha)) {
      return 'current-head-preserved';
    }
    freshPulls.push(pr);
  }

  // On pull_request events the run SHA is normally the historical branch
  // revision, but can instead be a synthetic PR merge commit. Such a merge
  // commit remains current if one of its parents is the current PR head,
  // even when the base branch has moved and the merge SHA changed.
  // A 404/unreadable commit is not proof of obsolescence: fail closed.
  let commit;
  try {
    commit = await api.commit(repo, run.head_sha);
  } catch {
    const source = run.head_repository?.full_name;
    if (!source || source === repo) return 'unverifiable-commit-preserved';
    try {
      commit = await api.commit(source, run.head_sha);
    } catch {
      return 'unverifiable-commit-preserved';
    }
  }
  if (!Array.isArray(commit.parents) || commit.parents.length === 0) {
    return 'unverifiable-commit-preserved';
  }
  if (freshPulls.some((pr) => commit.parents.some((parent) => parent.sha === pr.head.sha))) {
    return 'synthetic-or-descendant-head-preserved';
  }
  // A second live PR read prevents a force-push racing the commit inspection.
  for (const number of candidate.numbers) {
    const pr = await api.pull(repo, number);
    if (pr.state !== 'open' || run.head_sha === pr.head.sha ||
        (pr.merge_commit_sha && run.head_sha === pr.merge_commit_sha)) {
      return 'head-changed-preserved';
    }
  }
  if (!apply) return 'would-cancel';
  try {
    await api.cancel(repo, candidate.id);
  } catch (error) {
    // The run can finish after the final GET but before POST /cancel.
    // This is normal under load; only suppress a 404/409 when a fresh
    // read confirms the run has actually finished.
    if (error instanceof GitHubHttpError && [404, 409].includes(error.status)) {
      const after = await api.run(repo, candidate.id);
      if (!ACTIVE_STATUSES.includes(after.status)) return 'completed-before-cancel';
    }
    throw error;
  }
  return 'cancellation-requested';
}

export async function mapLimit(items, limit, operation) {
  let cursor = 0;
  const results = Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await operation(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error: String(error) };
      }
    }
  }));
  return results;
}

export async function scanRepository(api, repo, options, report = console) {
  const allRuns = await Promise.all(ACTIVE_STATUSES.map((status) => api.runs(repo.full_name, status)));
  const runs = [...new Map(allRuns.flat().map((run) => [run.id, run])).values()];
  const relevant = runs.filter((run) => run.event === 'pull_request' &&
    ACTIVE_STATUSES.includes(run.status) && run.pull_requests?.length);
  if (!relevant.length) return { runs: runs.length, candidates: 0, cancelled: 0, errors: 0 };
  const prs = new Map((await api.pulls(repo.full_name)).map((pr) => [pr.number, pr]));
  const candidates = relevant.map((run) => candidateForRun(run, prs)).filter(Boolean);
  let cancelled = 0;
  let errors = 0;
  for (const candidate of candidates) {
    try {
      const result = await confirmAndCancel(api, repo.full_name, candidate, options.apply);
      if (result === 'cancellation-requested') cancelled++;
      report.log(repo.full_name + ' #' + candidate.id + ' (' + candidate.name +
        ', PR ' + candidate.numbers.join(',') + '): ' + result);
    } catch (error) {
      errors++;
      report.error(repo.full_name + ' #' + candidate.id + ': ' + String(error));
    }
  }
  return { runs: runs.length, candidates: candidates.length, cancelled, errors };
}

export function parseArgs(argv) {
  const options = { owner: 'codeandsolder', repos: [], all: false, apply: false, hours: 72, parallel: 4 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--apply': options.apply = true; break;
      case '--all': options.all = true; break;
      case '--owner': options.owner = argv[++i]; break;
      case '--repo': options.repos.push(argv[++i]); break;
      case '--hours': options.hours = Number(argv[++i]); break;
      case '--parallel': options.parallel = Number(argv[++i]); break;
      default: throw new Error('Unknown argument: ' + arg);
    }
  }
  if (!options.owner || !/^[a-z0-9-]+$/i.test(options.owner)) {
    throw new Error('A valid owner is required');
  }
  if (!Number.isFinite(options.hours) || options.hours <= 0 ||
      !Number.isInteger(options.parallel) || options.parallel < 1 || options.parallel > 8) {
    throw new Error('Invalid hours or parallel limit');
  }
  options.repos = options.repos.map((repo) => repo.includes('/') ? repo : options.owner + '/' + repo);
  return options;
}

export async function main(argv, log = console) {
  const options = parseArgs(argv);
  const token = execFileSync('/usr/local/bin/gh', ['auth', 'token'],
    { encoding: 'utf8', timeout: 30_000 }).trim();
  const api = new GitHubApi(token);
  const installed = await api.repositories();
  const repos = installed.filter((repo) => eligibleRepository(repo, options));
  if (options.repos.length && repos.length !== options.repos.length) {
    throw new Error('Not all requested repositories are accessible through the installation');
  }
  log.log('CI guard ' + (options.apply ? 'APPLY' : 'DRY RUN') +
    ': ' + repos.length + '/' + installed.length + ' installed repositories');
  const completed = await mapLimit(repos, options.parallel,
    (repo) => scanRepository(api, repo, options, log));
  let errors = 0;
  let candidates = 0;
  let cancelled = 0;
  let inspected = 0;
  for (let i = 0; i < completed.length; i++) {
    const result = completed[i];
    if (!result.ok) {
      errors++;
      log.error(repos[i].full_name + ': ' + result.error);
      continue;
    }
    inspected += result.value.runs;
    candidates += result.value.candidates;
    cancelled += result.value.cancelled;
    errors += result.value.errors;
  }
  log.log('CI guard summary: ' + JSON.stringify({
    repos: repos.length, runs: inspected, obsolete: candidates,
    cancellationRequests: cancelled, errors,
  }));
  if (errors) throw new Error(errors + ' repositories could not be inspected safely');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('CI guard: ' + error.message);
    process.exitCode = 1;
  });
}
