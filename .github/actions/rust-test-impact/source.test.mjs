import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const action = readFileSync(new URL('./action.yml', import.meta.url), 'utf8');

test('upstream installation and coverage cache use the same immutable revision', () => {
  assert.match(action, /--git https:\/\/github\.com\/max-sixty\/cargo-affected\.git\b/);
  const revision = action.match(/--rev ([0-9a-f]{40})\b/)?.[1];
  assert.ok(revision, 'installation must pin an immutable upstream revision');
  assert.ok(action.includes("'cargo-affected-upstream-" + revision + "'"));
  assert.doesNotMatch(action, /codeandsolder\/cargo-affected|cargo-affected-fork-/);
});
