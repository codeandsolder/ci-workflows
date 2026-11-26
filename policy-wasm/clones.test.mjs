// Frozen independent acceptance cases from the retired Python classifier.
// Each case invokes the real compiled Rust/WASI policy, including host FS checks.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, symlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {workspace, write} from './test-workspace.mjs';

const provider = fileURLToPath(new URL('.', import.meta.url));
const repository = path.resolve(provider, '..');
const module = path.resolve(process.argv[2] ??
  fileURLToPath(new URL('module.json', import.meta.url)));
const golden = JSON.parse(readFileSync(
  new URL('tests/golden/clone-policy.json', import.meta.url), 'utf8'));
assert.equal(golden.schema, 1);
assert.equal(golden.cases.length, 23);

function classify(root, raw, {scanRoot = '.', production = 100, testing = 140} = {}) {
  const result = spawnSync(process.execPath, [
    path.join(provider, 'run.mjs'), module, 'clones', root,
    path.resolve(root, scanRoot), String(production), String(testing),
  ], {
    input: JSON.stringify(raw), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, result.signal);
  return result;
}
function group(tokens, fingerprint, locations) {
  return {tokens, fingerprint, occurrences: locations.map(([file, start_line, end_line]) =>
    ({file, start_line, end_line}))};
}
function report(...groups) {
  return {new: groups, smaller: [], resolved: [],
    summary: {files: 1, groups: groups.length}};
}

for (const entry of golden.cases) {
  test('frozen clone policy: ' + entry.name, t => {
    const root = workspace(t, 'ci-policy-clones-');
    for (const [file, contents] of Object.entries(entry.files)) write(root, file, contents);
    if (entry.config !== null) write(root, '.doppelscan.toml', entry.config);
    mkdirSync(path.join(root, entry.scan_root), {recursive: true});
    const result = classify(root, entry.input, {
      scanRoot: entry.scan_root, production: entry.production, testing: entry.testing,
    });
    if (Object.hasOwn(entry, 'error')) {
      assert.notEqual(result.status, 0, 'invalid legacy policy accepted: ' + entry.name);
      if (!entry.name.includes('not-table')) {
        assert.ok(result.stderr.includes(entry.error),
          entry.name + ': wanted diagnostic ' + JSON.stringify(entry.error) +
          ', got ' + result.stderr);
      }
    } else {
      assert.equal(result.status, 0, entry.name + ': ' + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), entry.expected, entry.name);
    }
  });
}

test('mandatory clone gate cannot weaken the centrally fixed scanner or WASI policy', () => {
  const workflow = readFileSync(
    path.join(repository, '.github/workflows/clone-regression.yml'), 'utf8');
  const mandatory = workflow.split('\npermissions:', 1)[0];
  assert.match(mandatory, /workflow_call:/);
  assert.doesNotMatch(mandatory, /inputs:/);
  assert.doesNotMatch(workflow, /\binputs\.|CLONE_GUARD_/);
  const script = readFileSync(
    path.join(repository, '.github/scripts/run-clone-regression.sh'), 'utf8');
  assert.ok(script.includes('readonly discovery=50 blocking=100 test_blocking=140'));
  assert.ok(script.includes("'tests/**' '**/tests/**'"));
  assert.ok(script.includes('--no-config'));
  assert.doesNotMatch(script, /CLONE_GUARD_|DOPPELSCAN_BIN/);
});

test('host rejects symlinked test source escaping checkout and scan-root boundaries', t => {
  const root = workspace(t, 'ci-policy-clones-');
  const outside = workspace(t, 'ci-policy-clones-');
  write(outside, 'test.rs', 'fn t() {}\n');
  write(root, 'src/prod.rs', 'fn production() {}\n');
  mkdirSync(path.join(root, 'tests'), {recursive: true});
  try {
    symlinkSync(path.join(outside, 'test.rs'), path.join(root, 'tests/escape.rs'));
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) {
      t.skip('host cannot create symlinks');
      return;
    }
    throw error;
  }
  const source = report(
    group(150, 'abcdef123456', [['tests/escape.rs',1,1]]),
    group(150, 'abcdef123457', [['src/prod.rs',1,1]]),
  );
  const result = classify(root, source);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.policy.blocking, 2);
  assert.deepEqual(data.new.map(item => item.policy_tier), ['production','production']);
  const nested = classify(root, source, {scanRoot: '..'});
  assert.notEqual(nested.status, 0, 'escaping scan root was accepted');
});

test('consumer receives a complete structured JSON classification without Python', t => {
  const root = workspace(t, 'ci-policy-clones-');
  write(root, 'src/a.rs', 'fn a() {}\n');
  const source = report(group(150, 'abcdef123456', [['src/a.rs',1,1]]));
  const result = classify(root, source);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.policy.blocking, 1);
  assert.deepEqual(parsed.new.map(group => group.policy_tier), ['production']);
  assert.deepEqual(parsed.smaller, []);
  assert.deepEqual(parsed.accepted, []);
  assert.deepEqual(parsed.summary, source.summary);
  assert.deepEqual(parsed.resolved, []);
  assert.equal(typeof parsed.note, 'string');
});
