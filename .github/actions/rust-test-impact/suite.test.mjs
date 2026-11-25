import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSuite, collectArgs, reportArgs } from './suite.mjs';

test('one canonical argument list drives the full instrumented execution', () => {
  const suite = parseSuite(JSON.stringify({
    directory: 'nested workspace',
    cargo: ['--workspace', '--locked', '--all-features', '--cargo-profile', 'fast'],
    nextest: ['--profile', 'ci', '--test-threads', '1', '-E', 'test(example name)'],
    doctests: ['--workspace', '--locked', '--all-features'],
  }));
  const args = collectArgs(suite, '/runner temporary/impact');
  const separator = args.indexOf('--');
  assert.deepEqual(args.slice(separator + 1), [
    '--no-fail-fast', '--message-format', 'libtest-json-plus',
    ...suite.cargo, ...suite.nextest,
  ]);
  assert.equal(args[args.indexOf('--aggregate-profile') + 1], '/runner temporary/impact/aggregate.profdata');
  assert.equal(args[args.indexOf('--build-info-json') + 1], '/runner temporary/impact/build.json');
  assert.deepEqual(suite.doctests, ['--workspace', '--locked', '--all-features']);
});

test('coverage is optional without changing full-suite or selection semantics', () => {
  const suite = parseSuite('{"coverage":false}');
  assert.deepEqual(suite.cargo, ['--workspace', '--locked']);
  const args = collectArgs(suite, '/tmp/impact');
  assert.ok(args.includes('--report-json'));
  assert.ok(!args.includes('--aggregate-profile'));
  assert.ok(!args.includes('--build-info-json'));
  assert.equal(suite.doctests, null);
});

test('reject invalid configurations and flags that take ownership of execution or output', () => {
  for (const value of [
    'null', '[]', '{"extra":true}', '{"directory":"../elsewhere"}',
    '{"directory":"/absolute"}', '{"cargo":"--workspace"}',
    '{"coverage":"yes"}', '{"nextest":["--message-format=json"]}',
    '{"cargo":["--target-dir","elsewhere"]}', '{"nextest":["--no-run"]}',
  ]) assert.throws(() => parseSuite(value), value);
});

test('coverage report layout is derived from actual Nextest metadata', () => {
  assert.deepEqual(reportArgs({'base-output-directories':['debug']}), ['llvm-cov', 'report', '--workspace', '--locked']);
  assert.deepEqual(reportArgs({'base-output-directories':['release']}), ['llvm-cov', 'report', '--workspace', '--locked', '--release']);
  assert.deepEqual(reportArgs({'base-output-directories':['aarch64-unknown-linux-gnu/custom']}), ['llvm-cov', 'report', '--workspace', '--locked', '--profile', 'custom', '--target', 'aarch64-unknown-linux-gnu']);
  assert.throws(() => reportArgs({'base-output-directories':['debug','release']}));
  assert.throws(() => reportArgs({'base-output-directories':['../debug']}));
});
