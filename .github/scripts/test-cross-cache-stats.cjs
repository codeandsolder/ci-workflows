const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-cache-stats-'));
const env = { ...process.env, GITHUB_ENV: path.join(dir, 'env') };
function run() {
  fs.writeFileSync(env.GITHUB_ENV, '');
  return spawnSync(process.execPath, ['.github/actions/finalize-sccache/verify-cross-stats.cjs', dir], { env, encoding: 'utf8' });
}
function stats(name, hits, misses, errors = 0) {
  fs.writeFileSync(path.join(dir, 'stats.' + name + '.json'), JSON.stringify({
    stats: { cache_read_errors: errors, cache_write_errors: 0, compile_requests: hits + misses,
      cache_hits: { counts: { Rust: hits } }, cache_misses: { counts: { Rust: misses } } }
  }));
}
try {
  assert.notEqual(run().status, 0);
  stats('empty', 0, 0);
  assert.notEqual(run().status, 0);
  stats('prime', 0, 4);
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(env.GITHUB_ENV, 'utf8'), /REFRESH=true/);
  stats('restore', 4, 0);
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(env.GITHUB_ENV, 'utf8'), /REFRESH=true/);
  fs.unlinkSync(path.join(dir, 'stats.prime.json'));
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(env.GITHUB_ENV, 'utf8'), /REFRESH=false/);
  stats('broken', 1, 1, 1);
  assert.notEqual(run().status, 0);
  console.log('Cross container cache statistics: PASS');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
