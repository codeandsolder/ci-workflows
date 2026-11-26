import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dependencyDirectories, parseStrictSuites, runStrictScopes } from './run.mjs';

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
  assert.throws(() => runStrictScopes(scopes, root, 'nightly-2026-11-23', (program, args, opts) => {
    calls.push({program,args,opts});
    return {status: calls.length === 1 ? 1 : 0};
  }), /a: 1/);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].program, 'cargo');
  assert.deepEqual(calls[1].args, ['+nightly-2026-11-23','report','future-incompatibilities']);
  assert.deepEqual(calls[2].args, [join(root,'.rust-skills2-gate','scripts','strict_clippy.sh'),'--toolchain','nightly-2026-11-23']);
  assert.equal(calls[2].opts.env.RUST_SKILLS2_WORKING_DIRECTORY,'native');
  assert.equal(calls[2].opts.env.RUST_SKILLS2_CARGO_ARGS,'--lib');
  assert.equal(calls[2].opts.env.RUST_SKILLS2_ALLOW_TEST_PANICS,'true');
  assert.equal(calls[2].opts.env.RUST_SKILLS2_ACTION_DIR,join(root,'.rust-skills2-gate','.github','actions','rust-strict'));
});
