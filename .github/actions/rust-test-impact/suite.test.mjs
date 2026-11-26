import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSuites, collectArgs, reportArgs, checkoutChanges } from './suite.mjs';

test('one canonical argument list drives the full instrumented execution', () => {
  const [suite] = parseSuites(JSON.stringify([{
    name: 'integration',
    directory: 'nested workspace',
    cargo: ['--workspace', '--locked', '--all-features', '--cargo-profile', 'fast'],
    nextest: ['--profile', 'ci', '--test-threads', '1', '-E', 'test(example name)'],
    doctests: ['--workspace', '--locked', '--all-features'],
  }]));
  const args = collectArgs(suite, '/runner temporary/impact', '/runner temporary/state');
  const separator = args.indexOf('--');
  assert.deepEqual(args.slice(separator + 1), [
    '--no-fail-fast', '--message-format', 'libtest-json-plus',
    ...suite.cargo, ...suite.nextest,
  ]);
  assert.equal(args[args.indexOf('--state-dir') + 1], '/runner temporary/state');
  assert.equal(args[args.indexOf('--aggregate-profile') + 1], '/runner temporary/impact/aggregate.profdata');
  assert.equal(args[args.indexOf('--build-info-json') + 1], '/runner temporary/impact/build.json');
  assert.deepEqual(suite.doctests, ['--workspace', '--locked', '--all-features']);
});

test('coverage is optional without changing full-suite or selection semantics', () => {
  const [suite] = parseSuites('[{"name":"unit","coverage":false}]');
  assert.deepEqual(suite.cargo, ['--workspace', '--locked']);
  const args = collectArgs(suite, '/tmp/impact', '/tmp/state');
  assert.ok(args.includes('--report-json'));
  assert.ok(!args.includes('--aggregate-profile'));
  assert.ok(!args.includes('--build-info-json'));
  assert.equal(suite.doctests, null);
});

test('reject invalid configurations and flags that take ownership of execution or output', () => {
  for (const value of [
    'null', '[]', '{}', '[{"name":"a","extra":true}]',
    '[{"name":"../elsewhere"}]', '[{"name":"a","directory":"../elsewhere"}]',
    '[{"name":"a","directory":"/absolute"}]', '[{"name":"a","cargo":"--workspace"}]',
    '[{"name":"a","coverage":"yes"}]', '[{"name":"a","nextest":["--message-format=json"]}]',
    '[{"name":"a","cargo":["--target-dir","elsewhere"]}]', '[{"name":"a","nextest":["--no-run"]}]',
    '[{"name":"a"},{"name":"a"}]',
  ]) assert.throws(() => parseSuites(value), value);
});

test('multiple named scopes preserve independent build and test arguments', () => {
  const suites = parseSuites(JSON.stringify([
    { name: 'default', cargo: ['--locked', '--lib'], nextest: ['--test-threads', '4'] },
    { name: 'dist', cargo: ['--locked', '--no-default-features', '--features=dist-server'], nextest: ['--run-ignored', 'all'] },
  ]));
  assert.deepEqual(suites.map(suite => suite.name), ['default', 'dist']);
  assert.ok(collectArgs(suites[0], '/tmp/impact/a', '/tmp/state/a').includes('--lib'));
  assert.ok(collectArgs(suites[1], '/tmp/impact/b', '/tmp/state/b').includes('--features=dist-server'));
});

test('coverage report layout is derived from actual Nextest metadata', () => {
  assert.deepEqual(reportArgs({'base-output-directories':['debug']}), ['llvm-cov', 'report', '--workspace', '--locked']);
  assert.deepEqual(reportArgs({'base-output-directories':['release']}), ['llvm-cov', 'report', '--workspace', '--locked', '--release']);
  assert.deepEqual(reportArgs({'base-output-directories':['aarch64-unknown-linux-gnu/custom']}), ['llvm-cov', 'report', '--workspace', '--locked', '--profile', 'custom', '--target', 'aarch64-unknown-linux-gnu']);
  assert.throws(() => reportArgs({'base-output-directories':['debug','release']}));
  assert.throws(() => reportArgs({'base-output-directories':['../debug']}));
});

test('continuous profiling is explicit, independent of aggregate reporting and argument scope', () => {
  const [normal, continuous] = parseSuites('[{"name":"normal"},{"name":"daemon","continuous":true,"coverage":false}]');
  assert.equal(normal.continuous, false);
  assert.equal(continuous.continuous, true);
  assert.ok(!collectArgs(normal, '/tmp/impact', '/tmp/state').includes('--continuous'));
  const args = collectArgs(continuous, '/tmp/impact', '/tmp/state');
  assert.ok(args.includes('--continuous'));
  assert.ok(!args.includes('--aggregate-profile'));
  assert.ok(args.indexOf('--continuous') < args.indexOf('--'));
  assert.throws(() => parseSuites('[{"name":"bad","continuous":"true"}]'));
});

test('checkout integrity diagnostics find tracked and untracked changes from nested workspaces', () => {
  const root = mkdtempSync(join(tmpdir(), 'rust-suite-checkout-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    writeFileSync(join(root, '.gitignore'), '/target/\n');
    writeFileSync(join(root, 'tracked.rs'), 'original\n');
    mkdirSync(join(root, 'nested'));
    mkdirSync(join(root, 'target'));
    git('add', '.');
    git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
    const cwd = join(root, 'nested');
    writeFileSync(join(root, 'target', 'ignored.profraw'), 'ignored');
    assert.equal(checkoutChanges(cwd), '');
    writeFileSync(join(root, 'tracked.rs'), 'changed\n');
    writeFileSync(join(root, 'default.profraw'), 'leaked');
    const changes = checkoutChanges(cwd);
    assert.match(changes, / M tracked\.rs/);
    assert.match(changes, /\?\? default\.profraw/);
    assert.doesNotMatch(changes, /ignored/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
