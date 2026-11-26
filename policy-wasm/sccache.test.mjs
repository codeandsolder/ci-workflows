// Frozen independent CPython/PyYAML/shell oracle acceptance of the real Rust/WASI policy.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {workspace, write} from './test-workspace.mjs';

const provider = fileURLToPath(new URL('.', import.meta.url));
const module = path.resolve(process.argv[2] ??
  fileURLToPath(new URL('module.json', import.meta.url)));
const golden = JSON.parse(readFileSync(
  new URL('tests/golden/rust-ci-sccache.json', import.meta.url), 'utf8'));
assert.equal(golden.schema, 1);
assert.equal(golden.cases.length, 48);
assert.equal(golden.cases.filter(item => !item.expected.length).length, 13);
assert.equal(golden.cases.filter(item => item.expected.length).length, 35);

function run(root, strictRef, repository = "") {
  const args = [path.join(provider, 'run.mjs'), module, 'sccache', root];
  args.push(strictRef ?? "", repository);
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, result.signal);
  return result;
}
for (const entry of golden.cases) {
  test('frozen sccache policy: ' + entry.id, t => {
    const root = workspace(t, 'ci-policy-sccache-');
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
  const result = run(root, null, "codeandsolder/ci-workflows");
  assert.equal(result.status, 0, result.stdout + '\n' + result.stderr);
  assert.match(result.stdout, /every detected Rust CI job uses canonical sccache/);
});

test('local cache actions require provider identity and exact preceding checkout', t => {
  const root = workspace(t, 'provider-checkout-');
  const pin = '1'.repeat(40);
  const workflow = (repo, ref, location, checkout = true) => `
jobs:
  build:
    steps:
${checkout ? `      - uses: actions/checkout@${pin}
        with:
          repository: ${repo}
          ref: ${ref}
          path: ${location}
` : ''}      - uses: ./${location}/.github/actions/setup-sccache
      - run: cargo test --locked
      - if: always()
        uses: ./${location}/.github/actions/finalize-sccache
`;
  const provider = 'codeandsolder/ci-workflows';
  const exactRepo = '${{ job.workflow_repository }}';
  const exactRef = '${{ job.workflow_sha }}';
  write(root, '.github/workflows/ci.yml', workflow(exactRepo, exactRef, 'provider'));
  assert.equal(run(root, null, provider).status, 0);
  assert.equal(run(root, null, 'codeandsolder/consumer').status, 1);
  assert.equal(run(root, null).status, 1);
  for (const fixture of [
    workflow('attacker/repo', exactRef, 'provider'),
    workflow(exactRepo, 'main', 'provider'),
    workflow(exactRepo, exactRef, 'provider', false),
  ]) {
    write(root, '.github/workflows/ci.yml', fixture);
    assert.equal(run(root, null, provider).status, 1);
  }
});

test('provider workflows never reference their own previous commit', () => {
  const root = path.resolve(provider, '..', '.github');
  for (const directory of ['workflows', 'actions']) {
    for (const entry of readdirSync(path.join(root, directory), {recursive: true, withFileTypes: true})) {
      if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
      const file = path.join(entry.parentPath, entry.name);
      assert.doesNotMatch(readFileSync(file, 'utf8'), /uses:\s*codeandsolder\/ci-workflows\//, file);
    }
  }
});
