import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateGate } from './evaluate.mjs';

const check = (needs, expected) => evaluateGate(JSON.stringify(needs), JSON.stringify(expected));
const status = result => ({ result, outputs: { ignored: 'do not log this output' } });
const required = [['scope', 'success'], ['rust', 'success']];

test('required dependencies must succeed and explicit skips must match', () => {
  assert.deepEqual(check({ scope: status('success'), rust: status('success') }, required),
    { checked: 2, problems: [] });
  assert.deepEqual(check({ scope: status('success'), rust: status('skipped') },
    [['scope', 'success'], ['rust', 'skipped']]), { checked: 2, problems: [] });
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.deepEqual(check({ scope: status('success'), rust: status(result) }, required).problems,
      [`rust: expected success, got ${result}`]);
  }
  for (const result of ['success', 'failure', 'cancelled']) {
    assert.deepEqual(check({ scope: status('success'), rust: status(result) },
      [['scope', 'success'], ['rust', 'skipped']]).problems, [`rust: expected skipped, got ${result}`]);
  }
});

test('absent or extra dependencies and malformed results fail closed', () => {
  assert.deepEqual(check({ scope: status('success') }, required).problems,
    ['rust: missing dependency result']);
  assert.deepEqual(check({ scope: status('success'), rust: status('success'), extra: status('success') }, required).problems,
    ['extra: unexpected dependency without an expectation']);
  for (const value of [null, [], {}, 'success', { result: 'neutral' }, { result: 'SUCCESS' }]) {
    assert.deepEqual(check({ scope: status('success'), rust: value }, required).problems,
      ['rust: malformed or unknown result']);
  }
});

test('invalid, duplicate, and vacuous expectations are rejected', () => {
  for (const expected of [null, {}, [], [['scope', 'skipped']], [['scope', 'failure']],
    [['scope', 'success'], ['scope', 'success']], [['scope', 'success'], ['bad id', 'skipped']],
    [['scope', 'success', 'extra']], [null], [[12, 'success']]]) {
    assert.throws(() => check({ scope: status('success') }, expected));
  }
  for (const needs of [null, [], 'success', 12]) assert.throws(() => check(needs, required));
  assert.throws(() => evaluateGate('{secret', '[]'), { message: 'needs must be valid JSON' });
  assert.throws(() => evaluateGate('{}', 'invalid'), { message: 'expected-results must be valid JSON' });
});

test('own job identifiers are used, not inherited object properties', () => {
  assert.deepEqual(check({}, [['constructor', 'success']]).problems, ['constructor: missing dependency result']);
  assert.deepEqual(evaluateGate('{"__proto__":{"result":"success"}}', '[["__proto__","success"]]'),
    { checked: 1, problems: [] });
});

test('CLI exits nonzero on bad evidence without printing job outputs', () => {
  const entry = fileURLToPath(new URL('./run.mjs', import.meta.url));
  const invoke = (needs, expected) => spawnSync(process.execPath, [entry], {
    encoding: 'utf8', env: { ...process.env, NEEDS_JSON: JSON.stringify(needs), EXPECTED_RESULTS: JSON.stringify(expected) },
  });
  const ok = invoke({ scope: status('success'), rust: status('success') }, required);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /all 2 dependency results/);
  const failed = invoke({ scope: status('success'), rust: status('cancelled') }, required);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /rust: expected success, got cancelled/);
  assert.doesNotMatch(failed.stdout + failed.stderr, /do not log this output/);
});
