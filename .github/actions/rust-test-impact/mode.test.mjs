import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const workflow = readFileSync(new URL('../../workflows/rust-sccache.yml', import.meta.url), 'utf8');

function step(name) {
  const sections = [...workflow.matchAll(/^      - name: ([^\n]+)\n([\s\S]*?)(?=^      - name: |(?![\s\S]))/gm)];
  const matches = sections.filter(([, title]) => title === name);
  assert.equal(matches.length, 1, `expected exactly one ${name} step`);
  return matches[0][0];
}

test('explicit collect/shadow path excludes automatic mode', () => {
  const explicit = step('Execute and compare test impact (explicit collect/shadow)');
  assert.match(explicit, /if: \$\{\{ inputs\.test-impact-mode == 'collect' \|\| inputs\.test-impact-mode == 'shadow' \}\}/);
});

test('automatic path selects mode and invokes impact action once', () => {
  assert.match(step('Select automatic Rust test-impact analysis'), /inputs\.test-impact-mode == 'auto'/);
  assert.match(step('Analyze Rust test impact automatically (informational)'), /mode: \$\{\{ steps\.auto-impact\.outputs\.mode \}\}/);
  assert.match(step('Enforce original Rust validation result'), /steps\.caller-command\.outcome == 'failure'/);
});
