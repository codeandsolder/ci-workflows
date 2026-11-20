const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const script = path.resolve('.github/actions/setup-sccache/public-cache-key.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-cache-key-'));
try {
  const run = (cmd, args, env = process.env) =>
    execFileSync(cmd, args, { cwd: tmp, env, encoding: 'utf8' });
  run('git', ['init', '-q']);
  const manifest = path.join(tmp, 'Cargo.toml');
  fs.writeFileSync(manifest, '[package]\nname="fixture"\nversion="0.1.0"\n');
  run('git', ['add', 'Cargo.toml']);
  fs.mkdirSync(path.join(tmp, 'bin'));
  fs.writeFileSync(path.join(tmp, 'bin', 'rustc'),
    '#!/bin/sh\nprintf "%s\\n" "$FAKE_RUSTC"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: path.join(tmp, 'bin') + ':' + process.env.PATH,
    GITHUB_OUTPUT: path.join(tmp, 'out'), GITHUB_ENV: path.join(tmp, 'env'),
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', ImageOS: 'ubuntu24', CACHE_SIZE_MIB: '6144',
    GITHUB_WORKFLOW: 'CI', GITHUB_JOB: 'rust', GITHUB_RUN_ID: '111', GITHUB_RUN_ATTEMPT: '1',
    CACHE_SCOPE: 'build', CACHE_RUST_TOOLCHAIN: 'stable', CACHE_RUSTFLAGS: '-D warnings',
    FAKE_RUSTC: 'compiler-a', RUSTC: 'rustc' };
  const key = () => {
    fs.writeFileSync(env.GITHUB_OUTPUT, ''); fs.writeFileSync(env.GITHUB_ENV, '');
    run('bash', [script], env);
    return Object.fromEntries(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('\n')
      .map(line => line.split('=')));
  };
  const a = key(); assert.deepEqual(a, key());
  // An outer runner workspace can contain several separately checked out Git
  // repositories. Select the intended one, not the shell's working directory.
  const nested = path.join(tmp, 'nested');
  fs.mkdirSync(nested);
  execFileSync('git', ['init', '-q', nested]);
  fs.copyFileSync(manifest, path.join(nested, 'Cargo.toml'));
  execFileSync('git', ['-C', nested, 'add', 'Cargo.toml']);
  env.CACHE_REPOSITORY_PATH = nested;
  assert.deepEqual(a, key());
  fs.appendFileSync(path.join(nested, 'Cargo.toml'), '\n[dependencies]\n');
  execFileSync('git', ['-C', nested, 'add', 'Cargo.toml']);
  const nestedChanged = key();
  assert.ok(nestedChanged.key.startsWith(a['workload-prefix']));
  assert.notEqual(nestedChanged.key, a.key);
  delete env.CACHE_REPOSITORY_PATH;
  env.GITHUB_RUN_ID = '222';
  const b = key(); assert.notEqual(a.key, b.key); assert.ok(b.key.startsWith(a['graph-prefix']));
  env.GITHUB_RUN_ATTEMPT = '2';
  const c = key(); assert.notEqual(b.key, c.key); assert.ok(c.key.startsWith(a['graph-prefix']));
  fs.appendFileSync(manifest, '\n[dependencies]\n'); run('git', ['add', 'Cargo.toml']);
  const d = key(); assert.ok(d.key.startsWith(a['workload-prefix'])); assert.ok(!d.key.startsWith(a['graph-prefix']));
  env.CACHE_SCOPE = 'test';
  const e = key(); assert.ok(e.key.startsWith(a['restore-prefix'])); assert.ok(!e.key.startsWith(a['workload-prefix']));
  env.FAKE_RUSTC = 'compiler-b'; assert.ok(!key().key.startsWith(a['restore-prefix']));
  console.log('Generation, workload, Cargo graph, and actual compiler identities: PASS');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
