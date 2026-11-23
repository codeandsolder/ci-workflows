import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const detector = new URL('detect.mjs', import.meta.url).pathname;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'shared-ci-lang-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['-C', root, 'init', '-q']);
  return root;
}
function add(root, name, text = '') {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  execFileSync('git', ['-C', root, 'add', '--', name]);
}
function scan(t, root) {
  const manifest = join(root, '.detected.json');
  const outputs = join(root, '.output');
  execFileSync('node', [detector, root, manifest, outputs]);
  return {
    report: JSON.parse(readFileSync(manifest, 'utf8')),
    outputs: readFileSync(outputs, 'utf8'),
  };
}

test('Rust-only checkout skips Java even with untracked Java in working tree', t => {
  const root = fixture(t);
  add(root, 'src/lib.rs', 'pub fn answer() -> u8 { 42 }');
  writeFileSync(join(root, 'Generated.java'), 'class Generated {}');
  const result = scan(t, root);
  assert.deepEqual(result.report.java, []);
  assert.deepEqual(result.report.rust, ['src/lib.rs']);
  assert.equal(result.report.has_java, false);
  assert.match(result.outputs, /^has_java=false$/m);
});
test('Java is detected anywhere in caller Git index, including scripts', t => {
  const root = fixture(t);
  add(root, 'ghidra_scripts/UEFI Helper.java', 'class Helper {}');
  add(root, 'src/main/java/One.java', 'class One {}');
  add(root, 'src/lib.rs', 'pub fn a() {}');
  const result = scan(t, root);
  assert.deepEqual(result.report.java,
    ['ghidra_scripts/UEFI Helper.java', 'src/main/java/One.java']);
  assert.equal(result.report.has_rust, true);
  assert.match(result.outputs, /^java_count=2$/m);
});
test('Missing tracked files and symlinks are not passed to analysis', t => {
  const root = fixture(t);
  add(root, 'Removed.java', 'class Removed {}');
  add(root, 'Alive.rs', 'pub fn alive() {}');
  rmSync(join(root, 'Removed.java'));
  const result = scan(t, root);
  assert.equal(result.report.has_java, false);
});
test('A Java file whose extension is only part of the name is not Java', t => {
  const root = fixture(t);
  add(root, 'Example.java.txt', 'text');
  add(root, 'README.md', 'text');
  const result = scan(t, root);
  assert.equal(result.report.has_java, false);
});
test('Detects mixed extra languages, preserves original Java and Rust manifest', t => {
  const root = fixture(t);
  add(root, 'src/main.rs', 'fn main() {}');
  add(root, 'tools/check.bash', '#!/bin/bash\ntrue\n');
  add(root, 'scripts/release', '#!/usr/bin/env bash\nexit 0\n');
  add(root, 'src/index.tsx', 'export const view = true');
  add(root, 'public/index.js', 'console.log(true)');
  add(root, 'shaders/fragment.wgsl', '@compute @workgroup_size(1) fn main() {}');
  add(root, 'ci/check.py', 'pass');
  add(root, 'tests/bad.sh.txt', 'not shell');
  const { report, outputs } = scan(t, root);
  assert.deepEqual(report.rust, ['src/main.rs']);
  assert.deepEqual(report.shell, ['scripts/release', 'tools/check.bash']);
  assert.deepEqual(report.typescript, ['src/index.tsx']);
  assert.deepEqual(report.javascript, ['public/index.js']);
  assert.deepEqual(report.wgsl, ['shaders/fragment.wgsl']);
  assert.deepEqual(report.python, ['ci/check.py']);
  for (const lang of ['shell', 'javascript', 'python', 'wgsl']) {
    assert.equal(report['has_' + lang], true);
    assert.match(outputs, new RegExp('^has_' + lang + '=true$', 'm'));
  }
  assert.match(outputs, /^typescript_count=1$/m);
});
test('Untracked and missing sources do not enable any new language modules', t => {
  const root = fixture(t);
  add(root, 'readme.md', 'doc');
  add(root, 'removed.wgsl', 'some wgsl');
  rmSync(join(root, 'removed.wgsl'));
  writeFileSync(join(root, 'generated.ts'), 'const generated = true');
  writeFileSync(join(root, 'generated.sh'), 'echo generated');
  const { report } = scan(t, root);
  for (const lang of ['shell', 'javascript', 'python', 'wgsl']) {
    assert.equal(report['has_' + lang], false);
  }
});
