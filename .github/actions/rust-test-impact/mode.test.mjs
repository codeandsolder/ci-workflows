import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const workflow = readFileSync(new URL('../../workflows/rust-sccache.yml', import.meta.url), 'utf8');
const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');
const implementation = readFileSync(new URL('./suite.mjs', import.meta.url), 'utf8');

function step(source, name, indent) {
  const pattern = new RegExp('^' + ' '.repeat(indent) + '- name: ([^\\n]+)\\n([\\s\\S]*?)(?=^' + ' '.repeat(indent) + '- name: |(?![\\s\\S]))', 'gm');
  const matches = [...source.matchAll(pattern)].filter(([, title]) => title === name);
  assert.equal(matches.length, 1, 'expected exactly one ' + name + ' step');
  return matches[0][0];
}

test('the provider only runs explicitly configured unified suites', () => {
  assert.match(step(workflow, 'Run unified authoritative Rust test suite', 6), /inputs\.test-suites != ''/);
  assert.doesNotMatch(workflow, /test-impact-mode|automatic.*test-impact analysis|coverage-report|coverage-cargo-args|coverage-working-directory|rust-coverage/);
  assert.match(workflow, /fetch-depth: .*inputs\.test-suites != ''/);
  assert.match(workflow, /HAS_TEST_SUITES.*inputs\.test-suites/);
});

test('one full collect per scope supplies comparison, baseline and coverage; failure remains authoritative', () => {
  assert.equal((action.match(/suite\.mjs" execute/g) ?? []).length, 1);
  assert.match(implementation, /for \(const \{ suite, cwd, stateDir, impactDir, coverageDir, baseline \} of plan\.entries\)/);
  assert.equal((implementation.match(/runFull\(suite, cwd, impactDir, stateDir\);/g) ?? []).length, 1);
  const save = step(action, 'Save successful coverage baselines', 4);
  assert.match(save, /steps\.full\.outcome == 'success'/);
  assert.match(save, /github\.event_name == 'pull_request'/);
  assert.match(step(action, 'Enforce authoritative test results', 4), /FULL_OUTCOME.*!= success/);
  assert.match(implementation, /if \(failed\) throw new Error\('One or more authoritative test scopes failed'\)/);
  assert.doesNotMatch(action, /cargo nextest run|cargo affected status|cargo llvm-cov --/);
});
