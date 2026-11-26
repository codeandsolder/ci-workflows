import assert from 'node:assert/strict';
import test from 'node:test';
import { compareImpact, renderSummary } from './compare.mjs';

const selection = {
  cache: { status: 'hit-with-divergence' },
  selection: {
    summary: { mode: 'selection' },
    selected_tests: [{ binary_id: 'example', test_name: 'tests::selected' }],
  },
};
const events = [
  { type: 'suite', event: 'started', nextest: { crate: 'example', test_binary: 'example', kind: 'lib' } },
  { type: 'test', event: 'failed', name: 'example::example$tests::selected' },
  { type: 'test', event: 'failed', name: 'example::example$tests::missed' },
  { type: 'test', event: 'ok', name: 'example::example$tests::passing' },
].map((x) => JSON.stringify(x)).join('\n');

test('identifies real failed tests omitted by selection', () => {
  const result = compareImpact(selection, events, false);
  assert.equal(result.evaluable, true);
  assert.equal(result.total, 3);
  assert.equal(result.failed, 2);
  assert.deepEqual(result.misses.map((x) => x.testName), ['tests::missed']);
  assert.match(renderSummary(result), /Potential false negative/);
});

test('cache miss is unknown, not false-negative-free evidence', () => {
  const result = compareImpact({ ...selection, cache: { status: 'miss-fingerprint' } }, events, false);
  assert.equal(result.evaluable, false);
  assert.deepEqual(result.misses, []);
  assert.match(renderSummary(result), /not evaluable/);
});

test('exact match with no failures counts as observed safe', () => {
  const safe = compareImpact({
    ...selection, cache: { status: 'hit-exact' },
  }, events.replaceAll('"event":"failed"', '"event":"ok"'), true);
  assert.equal(safe.evaluable, true);
  assert.equal(safe.failed, 0);
  assert.equal(safe.misses.length, 0);
});

test('suite identity handles integration and binary tests', () => {
  const nextest = [
    { type: 'suite', event: 'started', nextest: { crate: 'pkg', test_binary: 'smoke', kind: 'test' } },
    { type: 'test', event: 'failed', name: 'pkg::smoke$test_integration' },
    { type: 'suite', event: 'started', nextest: { crate: 'pkg', test_binary: 'cli', kind: 'bin' } },
    { type: 'test', event: 'failed', name: 'pkg::cli$test_main' },
  ].map((x) => JSON.stringify(x)).join('\n');
  const result = compareImpact({
    ...selection, selection: {
      summary: { mode: 'selection' },
      selected_tests: [{ binary_id: 'pkg::smoke', test_name: 'test_integration' }],
    },
  }, nextest, false);
  assert.equal(result.misses.length, 1);
  assert.equal(result.misses[0].binaryId, 'pkg::bin/cli');
});

test('real Nextest bin identities preserve hyphens in package and target', () => {
  const emitted = [
    { type: 'suite', event: 'started', test_count: 1, nextest: {
      crate: 'ci-policy', test_binary: 'ci-policy', kind: 'bin',
    } },
    { type: 'test', event: 'started', name: 'ci-policy::ci-policy$cache::tests::trust_refs' },
    { type: 'test', event: 'failed', name: 'ci-policy::ci-policy$cache::tests::trust_refs' },
  ].map((x) => JSON.stringify(x)).join('\n');
  const result = compareImpact({
    cache: { status: 'hit-exact' },
    selection: {
      summary: { mode: 'selection' },
      selected_tests: [
        { binary_id: 'ci-policy::bin/ci-policy', test_name: 'cache::tests::trust_refs' },
      ],
    },
  }, emitted, false);
  assert.equal(result.evaluable, true);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.misses, []);
});


test('failed full run without any failed test is inconclusive', () => {
  const passing = events.replaceAll('"event":"failed"', '"event":"ok"');
  const result = compareImpact(selection, passing, false);
  assert.equal(result.evaluable, false);
  assert.equal(result.failed, 0);
  assert.match(result.reason, /failed without an individual/);
});

test('estimates savings from executed test durations, not phantoms or ignored tests', () => {
  const sample = [
    {type:'suite',event:'started',nextest:{crate:'example',test_binary:'example',kind:'lib'}},
    {type:'test',event:'ok',name:'example::example$tests::selected',exec_time:4},
    {type:'test',event:'ok',name:'example::example$tests::passing',exec_time:12},
    {type:'test',event:'ignored',name:'example::example$tests::ignored'},
  ].map(JSON.stringify).join('\n');
  const report = structuredClone(selection);
  report.selection.selected_tests.push({binary_id:'example',test_name:'phantom'});
  const result = compareImpact(report, sample, true);
  assert.equal(result.total, 2);
  assert.equal(result.selected, 2);
  assert.equal(result.selectedExecuted, 1);
  assert.equal(result.executionSeconds, 16);
  assert.equal(result.selectedExecutionSeconds, 4);
  assert.equal(result.skippedExecutionSeconds, 12);
  assert.match(renderSummary(result), /12.00 s \(75.0%\)/);
  const miss = compareImpact({...report,cache:{status:'miss-no-coverage'}},sample,true);
  assert.equal(miss.executionSeconds,16);
  assert.equal(miss.skippedExecutionSeconds,null);
});

test('missing durations do not imply zero elapsed time', () => {
  const result = compareImpact(selection, events, false);
  assert.equal(result.timedTests, 0);
  assert.equal(result.executionSeconds, null);
  assert.equal(result.skippedExecutionSeconds, null);
});
