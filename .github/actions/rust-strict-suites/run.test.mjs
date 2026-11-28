import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dependencyDirectories, parseStrictSuites, preflightScopes, runStrictScopes } from './run.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'strict-suites-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const dir of ['.', 'native', 'other']) {
    mkdirSync(join(root, dir), {recursive: true});
    writeFileSync(join(root, dir, 'Cargo.toml'), '[workspace]\n');
  }
  return root;
}

test('preserve different target selectors and deduplicate dependency scans', t => {
  const root = fixture(t);
  const scopes = parseStrictSuites(JSON.stringify([
    {name:'native', directory:'native'},
    {name:'wasm', directory:'native', cargo:['--locked','--bins','--target','wasm32-wasip1']},
    {name:'other', directory:'other', 'allow-test-panics':true, 'dependency-quality':false},
  ]), root);
  assert.deepEqual(dependencyDirectories(scopes), ['native']);
  assert.deepEqual(scopes[0].cargo, ['--locked','--workspace','--all-targets']);
  assert.deepEqual(scopes[1].cargo, ['--locked','--bins','--target','wasm32-wasip1']);
  assert.equal(scopes[2].panics, true);
});

test('reject malformed scopes, traversal, duplicate names and ambiguous selector tokens', t => {
  const root = fixture(t);
  for (const scopes of [
    [], [{name:'../escape'}], [{name:'a'},{name:'a'}],
    [{name:'a',directory:'../outside'}], [{name:'a',cargo:['--features a b']}],
    [{name:'a','dependency-quality':'false'}], [{name:'a',ignore:true}],
  ]) assert.throws(() => parseStrictSuites(JSON.stringify(scopes), root));
  symlinkSync(tmpdir(), join(root, 'escape'));
  assert.throws(() => parseStrictSuites('[{"name":"a","directory":"escape"}]', root), /escapes/);
});

test('every exact selector executes even after a preceding scope fails', t => {
  const root = fixture(t);
  const scopes = parseStrictSuites('[{"name":"a"},{"name":"b","directory":"native","cargo":["--lib"],"allow-test-panics":true}]', root);
  const calls = [];
  assert.throws(() => runStrictScopes(scopes, root, 'nightly-2026-11-23', join(root,'plans'), (program, args, opts) => {
    calls.push({program,args,opts});
    return {status: calls.length === 1 ? 1 : 0};
  }), /a: 1/);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].program, 'cargo');
  assert.deepEqual(calls[1].args, ['+nightly-2026-11-23','report','future-incompatibilities']);
  assert.deepEqual(calls[2].args, [join(root,'.rust-skills2-gate','scripts','strict_clippy.sh'),'--toolchain','nightly-2026-11-23','--phase','compile','--plan',join(root,'plans','b')]);
  assert.equal(calls[2].opts.env.RUST_SKILLS2_WORKING_DIRECTORY,'native');
  assert.equal(calls[2].opts.env.RUST_SKILLS2_CARGO_ARGS,'--lib');
  assert.equal(calls[2].opts.env.RUST_SKILLS2_ALLOW_TEST_PANICS,'true');
  assert.equal(calls[2].opts.env.RUST_SKILLS2_ACTION_DIR,join(root,'.rust-skills2-gate','.github','actions','rust-strict'));
});

test('format the canonical workspace once, then preflight each exact scope before any compile', t => {
  const root = fixture(t);
  const scopes = parseStrictSuites(JSON.stringify([
    {name:'a', directory:'native'},
    {name:'b', directory:'native', cargo:['--lib']},
    {name:'member', directory:'other', cargo:['--bins'], 'allow-test-panics':true},
    {name:'separate', 'dependency-quality':false},
  ]), root);
  const calls = [];
  const directories = preflightScopes(scopes, root, 'nightly-2026-11-23', join(root,'plans'), (program,args,opts) => {
    calls.push({program,args,opts});
    if (program === 'cargo') {
      const workspace = opts.cwd === join(root,'other') ? join(root,'native') : opts.cwd;
      return {status:0, stdout:join(workspace,'Cargo.toml') + '\n'};
    }
    return {status:0};
  });
  assert.deepEqual(directories, ['native']);
  assert.equal(calls.filter(call => call.program === 'cargo').length, 3);
  const phases = calls.filter(call => call.program === 'bash');
  assert.deepEqual(phases.map(call => call.args[4]), ['format','format','preflight','preflight','preflight','preflight']);
  assert.deepEqual(phases.slice(0,2).map(call => call.opts.env.RUST_SKILLS2_WORKING_DIRECTORY), ['native','.']);
  assert.equal(phases[4].opts.env.RUST_SKILLS2_WORKING_DIRECTORY, 'other');
  assert.equal(phases[4].opts.env.RUST_SKILLS2_ALLOW_TEST_PANICS, 'true');
  assert.equal(phases[4].args.at(-1), join(root,'plans','member'));
});

test('reject formatting failure before any source/license checks or compilation', t => {
  const root = fixture(t);
  const scopes = parseStrictSuites('[{"name":"a"},{"name":"b","directory":"native"}]', root);
  const phases = [];
  assert.throws(() => preflightScopes(scopes, root, 'nightly-2026-11-23', join(root,'plans'), (program,args,opts) => {
    if (program === 'cargo') return {status:0,stdout:join(opts.cwd,'Cargo.toml')};
    phases.push(args[4]);
    return {status:1};
  }), /Rust formatting failed/);
  assert.deepEqual(phases,['format']);
});

test('stop on source or release-license rejection before later scopes compile', t => {
  const root = fixture(t);
  const scopes = parseStrictSuites('[{"name":"a"},{"name":"b","directory":"native"}]', root);
  const phases = [];
  assert.throws(() => preflightScopes(scopes, root, 'nightly-2026-11-23', join(root,'plans'), (program,args,opts) => {
    if (program === 'cargo') return {status:0,stdout:join(opts.cwd,'Cargo.toml')};
    phases.push(args[4]);
    return {status:args[4] === 'preflight' ? 1 : 0};
  }), /Rust preflight failed: a/);
  assert.deepEqual(phases,['format','format','preflight']);
});

test('workflow rejects policy before provisioning by default, prepares only when needed and prioritizes required validation', () => {
  const workflow = readFileSync(new URL('../../workflows/rust-sccache.yml', import.meta.url), 'utf8');
  const steps = [
    'Quarantine new external crates once across all workspaces',
    'Resolve one quarantined compiler',
    'Install minimal Rust toolchain',
    'Strict formatting, source and release-license preflight',
    'Install remaining Rust components and targets',
    'Install native build dependencies',
    'Setup mandatory sccache',
    'Prepare explicit caller prerequisites',
    'Strict preflight after explicit caller preparation',
    'Start advisory dependency reporting alongside compilation',
    'Enforce all strict Rust lint scopes',
    'Run unified authoritative Rust test suite',
    'Run additional caller validation',
    'Collect advisory dependency reporting',
    'Finalize mandatory sccache',
  ];
  let previous = -1;
  for (const step of steps) {
    const next = workflow.indexOf('      - name: ' + step + '\n');
    assert(next > previous, step + ' is absent or out of order');
    previous = next;
  }
  assert.match(workflow, /if: inputs.strict-suites != '' && inputs.prepare-command == ''/);
  assert.match(workflow, /if: inputs.strict-suites != '' && inputs.prepare-command != ''/);
  assert.match(workflow, /if: inputs.test-suites != ''\n/);
  assert.match(workflow, /STRICT_PLAN_DIR: .*steps.strict-early.outputs.plan-dir \|\| steps.strict-late.outputs.plan-dir/);
});

test('cheap language checks precede expensive WGSL and Java provisioning', () => {
  const workflow = readFileSync(new URL('../../workflows/source-quality.yml', import.meta.url), 'utf8');
  const wgsl = workflow.indexOf('      - name: Install stable Rust for WGSL');
  const java = workflow.indexOf('      - name: Install Java for PMD');
  for (const step of ['Check tracked shell sources','Check tracked JavaScript and TypeScript','Strict Ruff and ty for standalone Python projects']) {
    const position = workflow.indexOf('      - name: ' + step);
    assert(position >= 0 && position < wgsl && position < java);
  }
  assert.match(workflow.slice(wgsl, java), /if: \$\{\{ success\(\) && steps.detect.outcome/);
  assert.match(workflow.slice(java), /if: \$\{\{ success\(\) && steps.detect.outcome/);
});

test('legacy native jobs explicitly select a mandatory dependency scan without strict suites', () => {
  const workflow = readFileSync(new URL('../../workflows/rust-sccache.yml', import.meta.url), 'utf8');
  assert.match(workflow, /dependency-directories:\n/);
  assert.match(workflow, /Explicit dependency directories require a non-strict routine native Linux X64 job/);
  assert.match(workflow, /if: inputs\.dependency-directories != '' \|\|/);
  assert.match(workflow, /working-directories: .*inputs\.dependency-directories \|\| steps\.strict-early/);
  const collect = workflow.slice(workflow.indexOf('      - name: Collect mandatory dependency scan'), workflow.indexOf('      - name: Finalize mandatory sccache'));
  assert(!collect.includes('continue-on-error'));
  const standalone = readFileSync(new URL('../../workflows/rust-dependency-gate.yml', import.meta.url), 'utf8');
  assert.match(standalone, /working-directories: .*inputs\.working-directories/);
  assert.match(standalone, /repository-path: \.ci-workflows/);
  assert(!standalone.includes('continue-on-error'));
  assert(!standalone.includes('cargo build'));
});
