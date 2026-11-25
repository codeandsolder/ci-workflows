import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('./run.mjs', import.meta.url));
const modulePath = process.argv[2] || fileURLToPath(new URL('./module.json', import.meta.url));
const SHA = 'e007c336924c41b4d8931aabd60fa1614967657c';

function run(root) {
  return JSON.parse(execFileSync(process.execPath,
    [script, modulePath, 'strict-plan', root], {encoding:'utf8', stdio:['ignore','pipe','pipe']}));
}

const root = mkdtempSync(path.join(tmpdir(), 'ci-upstream-reviewed-plan-'));
const workflows = path.join(root,'.github','workflows');
try {
  mkdirSync(workflows,{recursive:true});
  writeFileSync(path.join(workflows,'strict.yml'),[
    'name: reviewed strict',
    'jobs:',
    '  strict:',
    '    uses: codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@'+SHA,
    '    with:',
    '      cargo-args: "--locked --workspace --all-targets"',
    '      python-ci-paths: |',
    '        tools/ci',
    '        scripts/ci',
    ''
  ].join('\n'));
  writeFileSync(path.join(workflows,'other.yml'),[
    'jobs:',
    '  auxiliary:',
    '    uses: codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@'+SHA,
    '    with:',
    '      working-directory: tools',
    '      checkout-submodules: recursive',
    ''
  ].join('\n'));
  const p = run(root);
  assert.equal(p.refSha,SHA);
  assert.equal(p.jobs.length,2);
  assert.deepEqual(p.jobs.map((x)=>x.job),['auxiliary','strict']);
  assert.equal(p.jobs[0].checkoutSubmodules,'recursive');
  assert.equal(p.jobs[1].cargoArgs,'--locked --workspace --all-targets');
  assert.equal(p.jobs[1].pythonCiPaths.trim(),'tools/ci\nscripts/ci');

  writeFileSync(path.join(workflows,'other.yml'),[
    'jobs:',
    '  auxiliary:',
    '    uses: codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@'+'a'.repeat(40),
    ''
  ].join('\n'));
  assert.throws(()=>run(root), /Command failed/);

  rmSync(path.join(workflows,'strict.yml'));
  writeFileSync(path.join(workflows,'other.yml'),'jobs: {other: {runs-on: ubuntu-latest}}\n');
  assert.throws(()=>run(root), /Command failed/);

  // Existing upstream-tracked Rust consumers with no direct strict job still
  // receive the real canonical policy and nightly from the pinned provider.
  const provider = path.join(root,'.ci-provider-strict.yml');
  const nightly = path.join(root,'.ci-provider-toolchain.toml');
  writeFileSync(provider, [
    'jobs:',
    '  pinned:',
    '    uses: codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@'+SHA,
    '    with:',
    '      rust-toolchain: __DOLLAR__{{ needs.pin.outputs.channel }}',
    ''
  ].join('\n').replace('__DOLLAR__',String.fromCharCode(36)));
  writeFileSync(nightly,'[toolchain]\nchannel = "nightly-2026-11-19"\n');
  const fallback = run(root);
  assert.equal(fallback.refSha,SHA);
  assert.equal(fallback.jobs.length,1);
  assert.equal(fallback.jobs[0].workflow,'reviewed-provider-default');
  assert.equal(fallback.jobs[0].cargoArgs,'--locked --workspace --all-targets');
  assert.equal(fallback.jobs[0].rustToolchain,'nightly-2026-11-19');

  writeFileSync(nightly,'[toolchain]\nchannel = "stable"\n');
  assert.throws(()=>run(root), /Command failed/);
  rmSync(provider);
  assert.throws(()=>run(root), /Command failed/);
  console.log('Reviewed strict-plan WASI bridge: explicit jobs, pinned provider default, mixed trust root and missing gate pass');
} finally {
  rmSync(root,{recursive:true,force:true});
}
