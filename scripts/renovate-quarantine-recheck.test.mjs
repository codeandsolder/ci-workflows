import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuarantineHold, classifyJob, decide, eligibleChecks } from './renovate-quarantine-recheck.mjs';

const log = [
 '2026-11-12T01:00:00Z Cargo release-age quarantine is still active:',
 '2026-11-12T01:00:01Z - abc 1.2.3: published 2026-11-11T21:56:00+00:00, younger than 72h',
 '2026-11-12T01:00:01Z - def 0.2.4: published 2026-11-11T21:57:08.123456+00:00, younger than 72h',
 '2026-11-12T01:00:02Z ##[error]Process completed with exit code 1.',
].join('\n');

test('all crates must age out, including fractions and UTC offsets', () => {
  const hold = parseQuarantineHold(log);
  assert.equal(hold.eligible, true);
  assert.equal(hold.blockers.length, 2);
  assert.equal(decide(hold, Date.parse('2026-11-14T22:20:00Z')), null);
  assert.equal(decide(hold, Date.parse('2026-11-14T21:57:08Z')), 'release-too-young');
});
test('missing metadata, malformed timestamps and unexpected reasons stay blocked', () => {
  for (const replacement of ['- x 1.0: missing authoritative crates.io publication time',
    '- x 1.0: crates.io lookup failed: timeout',
    '- x 1.0: published invalid, younger than 72h',
    '- x 1.0: published 2026-11-11T21:56:00+00:00, younger than 12h']) {
    assert.equal(parseQuarantineHold(log.replace(/- abc 1\.2\.3:.+/, replacement)).eligible, false);
  }
  assert.equal(parseQuarantineHold('error: build failed').eligible, false);
});
test('only one sole quarantine step, original attempt, matching commit qualifies', () => {
  const job = { status: 'completed', conclusion: 'failure', head_sha: 'abc', run_attempt: 1,
    steps: [{ name: 'Quarantine newly introduced crates.io versions across all workspaces', conclusion: 'failure' }] };
  assert.equal(classifyJob(job, 'abc'), null);
  assert.equal(classifyJob({ ...job, run_attempt: 2 }, 'abc'), 'already-retried');
  assert.equal(classifyJob(job, 'def'), 'stale-or-not-failed');
  assert.equal(classifyJob({ ...job, steps: [...job.steps, { name: 'Build', conclusion: 'failure' }] }, 'abc'), 'other-job-failure');
});
test('do not retry when other checks are pending or failed', () => {
  const age = { name: 'quarantine', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', id: 1 };
  assert.deepEqual(eligibleChecks([age]), [age]);
  const strictAge = { ...age, id: 8, name: 'strict-rust / Strict Rust + Python policy' };
  assert.deepEqual(eligibleChecks([strictAge]), [strictAge]);
  assert.equal(eligibleChecks([age, { ...age, id: 2, name: 'build' }]), null);
  assert.equal(eligibleChecks([age, { ...age, id: 3, status: 'in_progress' }]), null);
});
