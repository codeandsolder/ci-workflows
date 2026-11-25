import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuarantineHold, classifyJob, decide, eligibleChecks } from './renovate-quarantine-recheck.mjs';

const modulePath = process.argv[2];
const withModule = {parse: log => parseQuarantineHold(log, modulePath),
  job: (job, head) => classifyJob(job, head, modulePath),
  age: (hold, now, grace) => decide(hold, now, grace, modulePath),
  checks: checks => eligibleChecks(checks, modulePath)};

const log = [
 '2026-11-12T01:00:00Z Cargo release-age quarantine is still active:',
 '2026-11-12T01:00:01Z - abc 1.2.3: published 2026-11-11T21:56:00+00:00, younger than 72h',
 '2026-11-12T01:00:01Z - def 0.2.4: published 2026-11-11T21:57:08.123456+00:00, younger than 72h',
 '2026-11-12T01:00:02Z ##[error]Process completed with exit code 1.',
].join('\n');

test('all crates must age out, including fractions and UTC offsets', () => {
  const hold = withModule.parse(log);
  assert.equal(hold.eligible, true);
  assert.equal(hold.blockers.length, 2);
  assert.equal(withModule.age(hold, Date.parse('2026-11-14T22:20:00Z')), null);
  assert.equal(withModule.age(hold, Date.parse('2026-11-14T21:57:08Z')), 'release-too-young');
});
test('missing metadata, malformed timestamps and unexpected reasons stay blocked', () => {
  for (const replacement of ['- x 1.0: missing authoritative crates.io publication time',
    '- x 1.0: crates.io lookup failed: timeout',
    '- x 1.0: published invalid, younger than 72h',
    '- x 1.0: published 2026-11-11T21:56:00+00:00, younger than 12h']) {
    assert.equal(withModule.parse(log.replace(/- abc 1\.2\.3:.+/, replacement)).eligible, false);
  }
  assert.equal(withModule.parse('error: build failed').eligible, false);
});
test('only one sole quarantine step, original attempt, matching commit qualifies', () => {
  const job = { status: 'completed', conclusion: 'failure', head_sha: 'abc', run_attempt: 1,
    steps: [{ name: 'Quarantine newly introduced crates.io versions across all workspaces', conclusion: 'failure' }] };
  assert.equal(withModule.job(job, 'abc'), null);
  assert.equal(withModule.job({ ...job, run_attempt: 2 }, 'abc'), 'already-retried');
  assert.equal(withModule.job(job, 'def'), 'stale-or-not-failed');
  assert.equal(withModule.job({ ...job, steps: [...job.steps, { name: 'Build', conclusion: 'failure' }] }, 'abc'), 'other-job-failure');
});
test('do not retry when other checks are pending or failed', () => {
  const age = { name: 'quarantine', app: { slug: 'github-actions' }, status: 'completed', conclusion: 'failure', id: 1 };
  assert.deepEqual(withModule.checks([age]), [age]);
  const strictAge = { ...age, id: 8, name: 'strict-rust / Strict Rust + Python policy' };
  assert.deepEqual(withModule.checks([strictAge]), [strictAge]);
  const renamed = { ...age, id: 2, name: 'Custom build gate' };
  assert.deepEqual(withModule.checks([age, renamed]), [age, renamed]);
  assert.equal(withModule.checks([age, { ...age, id: 3, conclusion: 'cancelled' }]), null);
  assert.equal(withModule.checks([age, { ...age, id: 3, app: { slug: 'other' } }]), null);
  assert.equal(withModule.checks([age, { ...age, id: 3, status: 'in_progress' }]), null);
});

test('multiple quarantine blocks preserve the slowest crate and exact age', () => {
  const first = [
    'Cargo release-age quarantine is still active:',
    '- abc 1.0.0: published 2026-11-11T21:56:00Z, younger than 72h',
    '- def 1.0.1: published 2026-11-11T22:56:00+01:00, younger than 72h',
  ].join('\n');
  const second = [
    '\x1b[31mCargo release-age quarantine is still active:\x1b[0m',
    '2026-11-12T00:00:00Z - third 3.5.0: published 2026-11-11T23:56:00Z, younger than 72h',
    '2026-11-12T00:00:01Z ##[error] Process completed with exit code 1',
  ].join('\n');
  const hold = withModule.parse(first + '\n' + second);
  assert.equal(hold.eligible, true);
  assert.equal(hold.blockers.length, 3);
  const last = Date.parse('2026-11-14T23:56:00Z');
  assert.equal(hold.eligibleAt, last);
  assert.equal(withModule.age(hold, last + 15 * 60_000 - 1), 'release-too-young');
  assert.equal(withModule.age(hold, last + 15 * 60_000), null);
});

test('Gregorian dates, invalid offsets and sub-ms precision fail closed', () => {
  const make = timestamp => withModule.parse(
    'Cargo release-age quarantine is still active:\n' +
    '- sample 2.0.0: published ' + timestamp + ', younger than 72h\n');
  assert.equal(make('2024-02-29T01:02:03Z').eligible, true);
  assert.equal(make('2026-02-29T01:02:03Z').eligible, false);
  assert.equal(make('2026-11-11T21:57:08+25:00').eligible, false);
  const rounded = make('2026-11-11T21:57:08.123456Z');
  assert.equal(rounded.eligible, true);
  assert.equal(rounded.blockers[0].eligibleAt,
    Date.parse('2026-11-14T21:57:08.123Z') + 1);
  for (const bad of [
    '2026-11-11T21:57:08Zx',
    '2026-11-11T21:57:08',
    '2026-11-11T21:57:99Z',
  ]) assert.equal(make(bad).eligible, false);
});

test('no retry on any non-age failure, stale head or repeat attempt', () => {
  const good = {status:'completed',conclusion:'failure',head_sha:'abc',run_attempt:1,
    steps:[{name:'cargo release-age quarantine',conclusion:'failure'}]};
  assert.equal(withModule.job(good,'abc'),null);
  for (const mutated of [
    {...good,run_attempt:2},
    {...good,status:'in_progress'},
    {...good,conclusion:'success'},
    {...good,head_sha:'def'},
    {...good,steps:[{name:'Clippy',conclusion:'failure'}]},
    {...good,steps:[]},
  ]) assert.notEqual(withModule.job(mutated,'abc'),null);
  const github = id => ({id,status:'completed',conclusion:'failure',
    app:{slug:'github-actions'}});
  assert.deepEqual(withModule.checks([github(3), github(4)]),[github(3), github(4)]);
  for (const bad of [
    {id:9,status:'in_progress'},
    {id:9,status:'completed',conclusion:'failure',app:{slug:'other'}},
    {id:9,status:'completed',conclusion:'cancelled',app:{slug:'github-actions'}},
  ]) assert.equal(withModule.checks([github(3),bad]),null);
});
