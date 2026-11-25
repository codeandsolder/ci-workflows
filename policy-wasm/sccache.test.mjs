// Frozen independent CPython/PyYAML/shell oracle acceptance of the real Rust/WASI policy.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const provider = fileURLToPath(new URL('.', import.meta.url));
const module = path.resolve(process.argv[2] ??
  fileURLToPath(new URL('module.json', import.meta.url)));
const golden = JSON.parse(readFileSync(
  new URL('tests/golden/rust-ci-sccache.json', import.meta.url), 'utf8'));
assert.equal(golden.schema, 1);
assert.equal(golden.cases.length, 48);
assert.equal(golden.cases.filter(item => !item.expected.length).length, 13);
assert.equal(golden.cases.filter(item => item.expected.length).length, 35);

function workspace(t) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'ci-policy-sccache-'));
  t.after(() => rmSync(temporary, {recursive: true, force: true}));
  return realpathSync(temporary);
}
function write(root, relative, contents) {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), {recursive: true});
  writeFileSync(full, contents, 'utf8');
}
function run(root, strictRef) {
  const args = [path.join(provider, 'run.mjs'), module, 'sccache', root];
  if (strictRef !== null) args.push(strictRef);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, result.signal);
  return result;
}
for (const entry of golden.cases) {
  test('frozen sccache policy: ' + entry.id, t => {
    const root = workspace(t);
    write(root, '.github/workflows/ci.yml', entry.workflow);
    for (const [file, source] of Object.entries(entry.files)) write(root, file, source);
    const result = run(root, entry.strict_ref);
    assert.equal(result.status, Number(entry.expected.length > 0),
      entry.id + ': ' + result.stdout + '\n' + result.stderr);
    const actual = result.stdout.split(/\r?\n/).filter(line => line.startsWith('- '))
      .map(line => line.slice(2).replaceAll('\\', '/')).sort();
    assert.deepEqual(actual, entry.expected, entry.id);
    if (!entry.expected.length) {
      assert.match(result.stdout, /every detected Rust CI job uses canonical sccache/);
    } else {
      assert.match(result.stdout, /sccache policy violations/);
    }
  });
}
test('provider workflows comply with the compiled strict sccache gate', () => {
  const root = path.resolve(provider, '..');
  const result = run(root, null);
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.match(result.stdout, /every detected Rust CI job uses canonical sccache/);
});
