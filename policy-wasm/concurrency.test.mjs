// Reviewed, frozen outcomes of the retired independent Python YAML oracle.
// Runs the actual portable Rust/WASI checker, never reimplements policy.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, realpathSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const provider = fileURLToPath(new URL('.', import.meta.url));
const runner = path.join(provider, 'run.mjs');
const module = path.resolve(process.argv[2] ??
  fileURLToPath(new URL('module.json', import.meta.url)));
const snapshot = JSON.parse(readFileSync(
  new URL('./tests/golden/workflow-concurrency.json', import.meta.url), 'utf8'));
assert.equal(snapshot.schema, 1);
assert.equal(snapshot.cases.length, 56);
assert.equal(snapshot.cases.filter(item => !item.expected.length).length, 25);
assert.equal(snapshot.cases.filter(item => item.expected.length).length, 31);

function temporary(t) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'ci-policy-concurrency-'));
  t.after(() => rmSync(temporary, {recursive: true, force: true}));
  // Resolve platform filesystem aliases (notably macOS /var -> /private/var)
  // before the host workspace preopen and guest path checks.
  return realpathSync(temporary);
}
function run(root) {
  const result = spawnSync(process.execPath, [runner, module, 'concurrency', root],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, result.signal);
  return result;
}
function normalize(messages) {
  return messages.map(message => {
    const text = message.replaceAll('\\', '/');
    return text.includes(': invalid YAML:')
      ? text.split(': invalid YAML:', 1)[0] + ': invalid YAML'
      : text;
  }).sort();
}
for (const entry of snapshot.cases) {
  test('frozen workflow concurrency: ' + entry.id, t => {
    const root = temporary(t);
    const directory = path.join(root, '.github', 'workflows');
    mkdirSync(directory, {recursive: true});
    for (const [filename, source] of Object.entries(entry.files)) {
      writeFileSync(path.join(directory, filename), source, 'utf8');
    }
    const actual = run(root);
    assert.equal(actual.status, Number(entry.expected.length > 0),
      entry.id + ': ' + actual.stdout + '\n' + actual.stderr);
    const problems = normalize(actual.stdout.split(/\r?\n/)
      .filter(line => line.startsWith('- ')).map(line => line.slice(2)));
    assert.deepEqual(problems, entry.expected, entry.id);
    if (entry.expected.length === 0) {
      assert.match(actual.stdout, /workflows satisfy cancellation and portable runner policy/);
    } else {
      assert.match(actual.stdout, /workflow policy failures/);
    }
  });
}
test('the checked-in provider workflows satisfy the same portable Rust policy', () => {
  const root = path.resolve(provider, '..');
  const actual = run(root);
  assert.equal(actual.status, 0, actual.stdout + '\n' + actual.stderr);
  assert.match(actual.stdout, /workflows satisfy cancellation and portable runner policy/);
});
