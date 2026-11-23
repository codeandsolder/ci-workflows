import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { expand, plan } from './cargo-affected.mjs';

const module = path.resolve(process.argv[2] ??
  fileURLToPath(new URL('./module.json', import.meta.url)));

test('Cargo workspace selection through real Git/Cargo and portable WASI', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-affected-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const run = (...args) => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'});
  const put = (name, content) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), {recursive: true});
    writeFileSync(file, content);
  };
  const commit = (message) => {
    run('add', '-A');
    run('commit', '-qm', message);
    return run('rev-parse', 'HEAD').toString('utf8').trim();
  };
  run('init', '-qb', 'main');
  run('config', 'user.name', 'CI fixture');
  run('config', 'user.email', 'ci-fixture@example.invalid');
  put('Cargo.toml', '[workspace]\nmembers = ["a", "b"]\nresolver = "3"\n');
  put('a/Cargo.toml', '[package]\nname = "alpha"\nversion = "0.0.1"\nedition = "2024"\n');
  put('a/src/lib.rs', 'pub fn answer() -> u32 { 1 }\n');
  put('b/Cargo.toml', '[package]\nname = "beta"\nversion = "0.0.1"\nedition = "2024"\n[dependencies]\nalpha = { path = "../a" }\n');
  put('b/src/lib.rs', 'pub fn answer() -> u32 { alpha::answer() }\n');
  put('README.md', 'Docs\n');
  put('.github/cargo-affected.json', JSON.stringify({
    full_paths: ['Cargo.toml', 'Cargo.lock'],
    full_prefixes: ['.cargo'],
    ignored_paths: ['README.md'],
    ignored_prefixes: ['docs'],
    triggers: [{flag: 'check_schema', prefixes: ['schema'], packages: ['beta']}],
    matrices: {
      full: {include: [{os: 'all'}]},
      partial: {include: [{os: 'linux'}]},
    },
  }));
  let base = commit('initial workspace');

  put('a/src/lib.rs', 'pub fn answer() -> u32 { 2 }\n');
  let head = commit('change dependency');
  let result = plan(module, root, '.github/cargo-affected.json', 'pull_request', base, head);
  assert.deepEqual(result.affected_packages, ['alpha', 'beta']);
  assert.equal(result.run_full, false);
  assert.equal(result.extra_flags.check_schema, false);
  assert.deepEqual(result.test_matrix.include, [{os:'linux'}]);

  base = head;
  put('README.md', 'Updated docs\n');
  head = commit('docs only');
  result = plan(module, root, '.github/cargo-affected.json', 'pull_request', base, head);
  assert.deepEqual(result.affected_packages, []);
  assert.equal(result.has_code, false);

  base = head;
  put('schema/plugin.wit', 'package example:test;\n');
  head = commit('schema only');
  result = plan(module, root, '.github/cargo-affected.json', 'pull_request', base, head);
  assert.deepEqual(result.affected_packages, ['beta']);
  assert.equal(result.extra_flags.check_schema, true);

  base = head;
  put('unknown-root.dat', 'Potential build input\n');
  head = commit('unknown shared input');
  result = plan(module, root, '.github/cargo-affected.json', 'pull_request', base, head);
  assert.equal(result.run_full, true);
  assert.deepEqual(result.affected_packages, ['alpha', 'beta']);

  result = plan(module, root, '.github/cargo-affected.json', 'workflow_dispatch', '', '');
  assert.equal(result.run_full, true);
  assert.equal(result.extra_flags.check_schema, true);
  assert.deepEqual(result.test_matrix.include, [{os:'all'}]);

  assert.deepEqual(expand(module, root, ['alpha', 'beta'],
    ['cargo', 'nextest', 'run', '--verbose']),
    ['cargo', 'nextest', 'run', '-p', 'alpha', '-p', 'beta', '--verbose']);
  assert.deepEqual(expand(module, root, ['alpha'], ['cargo','ndk','-t','arm64-v8a','build']),
    ['cargo', 'ndk','-t','arm64-v8a','build','-p','alpha']);
  assert.throws(() => expand(module, root, ['--workspace'], ['cargo','test']));

  // Also exercise the public composite-action command-line/output interface.
  const cli = fileURLToPath(new URL('./cargo-affected.mjs', import.meta.url));
  const output = path.join(root, 'action-outputs.txt');
  execFileSync(process.execPath, [
    cli, 'plan', module, root, '.github/cargo-affected.json',
    'pull_request', base, head, output,
  ], {stdio: 'pipe'});
  const values = Object.fromEntries(readFileSync(output, 'utf8').trim()
    .split('\n').map(line => {
      const delimiter = line.indexOf('=');
      return [line.slice(0, delimiter), line.slice(delimiter + 1)];
    }));
  assert.equal(values.run_full, 'true');
  assert.deepEqual(JSON.parse(values.affected_packages), ['alpha','beta']);
  assert.deepEqual(JSON.parse(values.extra_flags), {check_schema: false});

  // A true run invokes Cargo with a checked argv, not via a shell.
  execFileSync(process.execPath, [
    cli, 'run', module, root, JSON.stringify(['alpha','beta']),
    JSON.stringify(['cargo','check','--offline','--target-dir',path.join(root,'build')]),
  ], {stdio: 'pipe'});
});
