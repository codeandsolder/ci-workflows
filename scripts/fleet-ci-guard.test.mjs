import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVE_STATUSES, GitHubApi, GitHubHttpError, candidateForRun, confirmAndCancel,
  eligibleRepository, mapLimit, parseArgs, scanRepository,
} from './fleet-ci-guard.mjs';

const initial = 'a'.repeat(40);
const updated = 'b'.repeat(40);
const merged = 'c'.repeat(40);
const repo = { full_name: 'codeandsolder/demo', pushed_at: '2026-11-18T15:00:00Z',
  owner: { login: 'codeandsolder' }, archived: false, disabled: false };

function pull(number, sha, state = 'open') {
  return { number, state, head: { sha }, merge_commit_sha: merged };
}

function run(status = 'queued', sha = initial, extra = {}) {
  return { id: 17, event: 'pull_request', status, name: 'Rust CI',
    head_sha: sha, head_branch: 'fix/bug', pull_requests: [
      { number: 8, head: { sha: initial } },
    ], ...extra };
}

test('only actively maintained installed repos match schedule', () => {
  const opts = parseArgs(['--owner', 'codeandsolder', '--hours', '48']);
  const now = Date.parse('2026-11-18T16:00:00Z');
  assert.equal(eligibleRepository(repo, opts, now), true);
  assert.equal(eligibleRepository({ ...repo, archived: true }, opts, now), false);
  assert.equal(eligibleRepository({ ...repo, owner: { login: 'someone-else' } }, opts, now), false);
  assert.equal(eligibleRepository({ ...repo, pushed_at: '2026-11-01T15:00:00Z' }, opts, now), false);
  assert.equal(eligibleRepository({ ...repo, pushed_at: '2026-11-01T15:00:00Z' },
    parseArgs(['--repo', 'demo']), now), true);
  assert.equal(eligibleRepository({ ...repo, pushed_at: '2026-11-01T15:00:00Z' },
    parseArgs(['--all']), now), true);
});

test('CLI defaults to dry run and validates arguments', () => {
  assert.deepEqual(parseArgs([]), {
    owner: 'codeandsolder', repos: [], all: false, apply: false, hours: 72, parallel: 4,
  });
  assert.deepEqual(parseArgs(['--repo', 'demo', '--apply']).repos, ['codeandsolder/demo']);
  for (const args of [['--bogus'], ['--parallel', '0'], ['--parallel', '9'],
    ['--hours', '0'], ['--hours', 'not-a-number'], ['--owner', '']]) {
    assert.throws(() => parseArgs(args));
  }
});

test('cancel only provably superseded PR revision', () => {
  const prs = new Map([[8, pull(8, updated)]]);
  const candidate = candidateForRun(run(), prs);
  assert.deepEqual(candidate, {
    id: 17, sha: initial, numbers: [8], name: 'Rust CI', status: 'queued',
  });
  for (const status of ACTIVE_STATUSES) {
    assert.ok(candidateForRun(run(status), prs), status);
  }
});

test('preserve current source head and synthetic PR merge revisions', () => {
  assert.equal(candidateForRun(run(), new Map([[8, pull(8, initial)]])), null);
  assert.equal(candidateForRun(run('queued', merged), new Map([[8, pull(8, updated)]])), null);
  assert.equal(candidateForRun(run('queued', updated), new Map([[8, pull(8, updated)]])), null);
});

test('GitHub rehydrates attached PR head to current SHA on old runs', () => {
  const stale = run('queued', initial, {
    pull_requests: [{ number: 8, head: { sha: updated } }],
  });
  assert.ok(candidateForRun(stale, new Map([[8, pull(8, updated)]])));
});

test('synthetic merge commit with current PR head as parent is preserved', async () => {
  const candidate = candidateForRun(run(), new Map([[8, pull(8, updated)]]));
  let cancelled = false;
  const api = {
    run: async () => run(), pull: async () => pull(8, updated),
    commit: async () => ({ parents: [{ sha: merged }, { sha: updated }] }),
    cancel: async () => { cancelled = true; },
  };
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, true),
    'synthetic-or-descendant-head-preserved');
  assert.equal(cancelled, false);
});

test('missing Git commit history never authorizes cancellation', async () => {
  const candidate = candidateForRun(run(), new Map([[8, pull(8, updated)]]));
  const api = {
    run: async () => run(), pull: async () => pull(8, updated),
    commit: async () => { throw Error('GitHub commit not available'); },
    cancel: async () => { throw Error('unexpected cancellation'); },
  };
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, true),
    'unverifiable-commit-preserved');
});

test('never cancel push, merge-queue, PR closing or already finished work', () => {
  const prs = new Map([[8, pull(8, updated)]]);
  assert.equal(candidateForRun(run('completed'), prs), null);
  assert.equal(candidateForRun(run('queued', initial, { event: 'push' }), prs), null);
  assert.equal(candidateForRun(run('queued', initial, { event: 'merge_group' }), prs), null);
  assert.equal(candidateForRun(run('queued', initial, { pull_requests: [] }), prs), null);
  assert.equal(candidateForRun(run('queued'), new Map()), null);
  assert.equal(candidateForRun(run('queued'), new Map([[8, pull(8, updated, 'closed')]])), null);
});

test('multi-PR association preserves a run needed by either current PR', () => {
  const multi = run('queued', initial, { pull_requests: [
    { number: 8, head: { sha: initial } },
    { number: 9, head: { sha: initial } },
  ] });
  assert.equal(candidateForRun(multi, new Map([[8, pull(8, updated)], [9, pull(9, initial)]])), null);
  assert.ok(candidateForRun(multi, new Map([[8, pull(8, updated)], [9, pull(9, updated)]])));
});

test('live recheck prevents race against an updated PR head', async () => {
  let calls = 0;
  const api = {
    run: async () => run(),
    pull: async () => pull(8, initial),
    cancel: async () => { calls++; },
  };
  const candidate = candidateForRun(run(), new Map([[8, pull(8, updated)]]));
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, true), 'current-head-preserved');
  assert.equal(calls, 0);
});

test('live recheck preserves changed run statuses and associations', async () => {
  const candidate = candidateForRun(run(), new Map([[8, pull(8, updated)]]));
  const api = { run: async () => run('completed'), cancel: async () => { throw Error('cancel!'); } };
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, true), 'no-longer-eligible');
  api.run = async () => run('queued', initial, { pull_requests: [{ number: 9 }] });
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, true), 'changed-associations');
});

test('default dry run never calls cancel; apply only after second check', async () => {
  let count = 0;
  const api = { run: async () => run(), pull: async () => pull(8, updated),
    commit: async () => ({ parents: [{ sha: 'd'.repeat(40) }] }),
    cancel: async () => { count++; } };
  const candidate = candidateForRun(run(), new Map([[8, pull(8, updated)]]));
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, false), 'would-cancel');
  assert.equal(count, 0);
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, true), 'cancellation-requested');
  assert.equal(count, 1);
});

test('parallel worker errors do not suppress healthy repos', async () => {
  const result = await mapLimit(['a', 'b', 'c'], 2, async (name) => {
    if (name === 'b') throw Error('failure');
    return name;
  });
  assert.deepEqual(result.map((x) => x.ok), [true, false, true]);
});

test('scan inspects every active workflow state and deduplicates run IDs', async () => {
  let cancelCalls = 0;
  const api = {
    runs: async (_repository, status) => status === 'queued' ? [run()] :
      status === 'pending' ? [run()] : [],
    pulls: async () => [pull(8, updated)],
    run: async () => run(),
    pull: async () => pull(8, updated),
    commit: async () => ({ parents: [{ sha: 'd'.repeat(40) }] }),
    cancel: async () => { cancelCalls++; },
  };
  const messages = [];
  const outcome = await scanRepository(api, repo,
    { apply: true }, { log: (message) => messages.push(message) });
  assert.deepEqual(outcome, { runs: 1, candidates: 1, cancelled: 1, errors: 0 });
  assert.equal(cancelCalls, 1);
  assert.equal(messages.length, 1);
});

test('run completion between GET and POST /cancel is a normal race', async () => {
  const candidate = candidateForRun(run(), new Map([[8, pull(8, updated)]]));
  let reads = 0;
  const api = {
    run: async () => (++reads === 1 ? run() : run('completed')),
    pull: async () => pull(8, updated),
    commit: async () => ({ parents: [{ sha: 'd'.repeat(40) }] }),
    cancel: async () => { throw new GitHubHttpError(409, 'POST', '/cancel',
      'Cannot cancel a workflow run that is completed'); },
  };
  assert.equal(await confirmAndCancel(api, repo.full_name, candidate, true),
    'completed-before-cancel');
  assert.equal(reads, 2);
});

test('409 is not silently ignored if cancellation is still required', async () => {
  const candidate = candidateForRun(run(), new Map([[8, pull(8, updated)]]));
  const api = {
    run: async () => run(),
    pull: async () => pull(8, updated),
    commit: async () => ({ parents: [{ sha: 'd'.repeat(40) }] }),
    cancel: async () => { throw new GitHubHttpError(409, 'POST', '/cancel',
      'Cannot cancel an active run'); },
  };
  await assert.rejects(confirmAndCancel(api, repo.full_name, candidate, true),
    (error) => error instanceof GitHubHttpError && error.status === 409);
});

test('one cancellation error does not discard other runs or metrics', async () => {
  const first = run('queued', initial, { id: 17 });
  const second = run('queued', initial, { id: 18 });
  let errors = 0;
  const api = {
    runs: async (_repository, status) => status === 'queued' ? [first, second] : [],
    pulls: async () => [pull(8, updated)],
    run: async (_repository, id) => id === 17 ? first : second,
    pull: async () => pull(8, updated),
    commit: async () => ({ parents: [{ sha: 'd'.repeat(40) }] }),
    cancel: async (_repository, id) => { if (id === 18) throw Error('HTTP 403'); },
  };
  const outcome = await scanRepository(api, repo, { apply: true },
    { log: () => {}, error: () => { errors++; } });
  assert.deepEqual(outcome, { runs: 2, candidates: 2, cancelled: 1, errors: 1 });
  assert.equal(errors, 1);
});

test('REST client paginates and never leaks auth into result', async () => {
  const paths = [];
  const transport = async (url, options) => {
    paths.push(new URL(url).searchParams.get('page'));
    assert.equal(options.headers.Authorization, 'Bearer secret');
    const page = Number(new URL(url).searchParams.get('page'));
    return new Response(JSON.stringify({ workflow_runs: page === 1 ?
      Array.from({ length: 100 }, (_, i) => ({ id: i })) : [{ id: 100 }] }),
    { status: 200, headers: { 'x-ratelimit-remaining': '2000' } });
  };
  const api = new GitHubApi('secret', transport);
  assert.equal((await api.runs('codeandsolder/demo', 'queued')).length, 101);
  assert.deepEqual(paths, ['1', '2']);
});
