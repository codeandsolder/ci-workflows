import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const workflow = readFileSync(new URL('../../workflows/rust-sccache.yml', import.meta.url), 'utf8');
const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');

function step(source, name, indent) {
  const pattern = new RegExp('^' + ' '.repeat(indent) + '- name: ([^\\n]+)\\n([\\s\\S]*?)(?=^' + ' '.repeat(indent) + '- name: |(?![\\s\\S]))', 'gm');
  const matches = [...source.matchAll(pattern)].filter(([, title]) => title === name);
  assert.equal(matches.length, 1, 'expected exactly one ' + name + ' step');
  return matches[0][0];
}

test('the provider only runs the explicitly configured unified suite', () => {
  assert.match(step(workflow, 'Run unified authoritative Rust test suite', 6), /inputs\.test-suite != ''/);
  assert.doesNotMatch(workflow, /test-impact-mode|automatic.*test-impact analysis/);
  assert.match(workflow, /fetch-depth: .*inputs\.test-suite != ''/);
  assert.match(workflow, /HAS_TEST_SUITE.*inputs\.test-suite/);
});

test('one full collect supplies comparison, baseline, and coverage; failure remains authoritative', () => {
  assert.equal((action.match(/suite\.mjs" collect/g) ?? []).length, 1);
  assert.match(step(action, 'Compare prior selection with actual full-suite results', 4), /steps\.full\.outcome == 'success'/);
  const save = step(action, 'Save successful coverage baseline', 4);
  assert.match(save, /steps\.full\.outcome == 'success'/);
  assert.match(save, /github\.event_name == 'pull_request'/);
  assert.match(step(action, 'Generate coverage reports from the same execution', 4), /suite\.mjs" report/);
  assert.match(step(action, 'Enforce authoritative full-suite result', 4), /FULL_OUTCOME.*!= success/);
  assert.doesNotMatch(action, /cargo nextest run|cargo affected status|cargo llvm-cov --/);
});
