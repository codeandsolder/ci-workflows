import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { collector } from './suite.mjs';

const source = readFileSync(new URL('./suite.mjs', import.meta.url), 'utf8');

test('collector installation and baseline scope share one immutable source pin', () => {
  assert.match(collector.repository, /^https:\/\/github\.com\/(?:max-sixty|codeandsolder)\/cargo-affected\.git$/);
  assert.match(collector.revision, /^[0-9a-f]{40}$/);
  assert.match(source, /collector\.repository, collector\.revision, nextestVersion, process\.platform/);
  assert.match(source, /'--git', collector\.repository, '--rev', collector\.revision/);
});
