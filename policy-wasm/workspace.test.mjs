import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspace } from './workspace.mjs';

test('workspace resolves literal paths, missing paths and sorted workflows', (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'ci-policy-test-'));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const root = realpathSync(temp);
  mkdirSync(path.join(root, '.github/workflows'), {recursive: true});
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, '.github/workflows/z.yml'), 'jobs: {}');
  writeFileSync(path.join(root, '.github/workflows/a.yaml'), 'jobs: {}');
  writeFileSync(path.join(root, '.github/workflows/ignored'), '');
  writeFileSync(path.join(root, 'scripts/build.sh'), 'cargo test');
  const host = workspace(root);
  assert.deepEqual(host.workflowPaths(), ['/workspace/.github/workflows/a.yaml', '/workspace/.github/workflows/z.yml']);
  assert.equal(host.lookup('/workspace/scripts/build.sh'), 'f/workspace/scripts/build.sh');
  assert.equal(host.lookup('/workspace/scripts/../scripts'), 'd/workspace/scripts');
  assert.equal(host.lookup('/workspace/absent/leaf'), 'm/workspace/absent/leaf');
  assert.equal(host.lookup('/workspace/../outside'), null);
  assert.equal(host.lookup(path.join(root, 'scripts', 'build.sh')), 'f/workspace/scripts/build.sh');
});

test('workspace follows symlinks before dot-dot and rejects escapes and cycles', (t) => {
  const temp = mkdtempSync(path.join(tmpdir(), 'ci-policy-symlinks-'));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  const root = path.join(realpathSync(temp), 'checkout');
  mkdirSync(path.join(root, 'scripts/inner'), {recursive: true});
  mkdirSync(path.join(root, '.github/workflows'), {recursive: true});
  writeFileSync(path.join(root, 'scripts/build.sh'), '');
  writeFileSync(path.join(temp, 'external.yml'), 'jobs: {}');
  try {
    symlinkSync(path.join('scripts', 'inner'), path.join(root, 'link'), 'dir');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows runner does not permit creating symbolic links');
      return;
    }
    throw error;
  }
  symlinkSync(path.join('..', 'external.yml'), path.join(root, 'escape'), 'file');
  symlinkSync('cycle', path.join(root, 'cycle'), 'file');
  symlinkSync(path.join(temp, 'external.yml'), path.join(root, '.github/workflows/escape.yml'), 'file');
  const host = workspace(root);
  assert.equal(host.lookup('/workspace/link/../build.sh'), 'f/workspace/scripts/build.sh');
  assert.equal(host.lookup('/workspace/escape'), null);
  assert.equal(host.lookup('/workspace/cycle'), null);
  assert.throws(() => host.workflowPaths(), /escapes the checkout/);
});
