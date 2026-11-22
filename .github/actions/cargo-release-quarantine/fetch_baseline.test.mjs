// Native Git transport regression. No Python interpreter is needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fetchBaseline = fileURLToPath(new URL('./fetch_baseline.sh', import.meta.url));

function run(cwd, command, args) {
  const result = spawnSync(command, args, {cwd, encoding: 'utf8'});
  if (result.error) throw result.error;
  assert.notEqual(result.status, null, command + ' terminated by ' + result.signal);
  return result;
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function author(repo) {
  git(repo, 'config', 'user.name', 'Quarantine Regression');
  git(repo, 'config', 'user.email', 'quarantine@example.invalid');
}

test('fetch missing historical baseline without fetching unreachable submodules', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'quarantine-fetch-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const subsource = path.join(root, 'subsource');
  const subremote = path.join(root, 'submodule.git');
  const source = path.join(root, 'source');
  const remote = path.join(root, 'super.git');

  git(root, 'init', '-q', '-b', 'main', subsource);
  author(subsource);
  writeFileSync(path.join(subsource, 'fixture.txt'), 'fixture\n');
  git(subsource, 'add', 'fixture.txt');
  git(subsource, 'commit', '-qm', 'available submodule revision');
  git(root, 'clone', '--bare', '-q', subsource, subremote);

  git(root, 'init', '-q', '-b', 'main', source);
  author(source);
  git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subremote, 'resources');
  git(source, 'commit', '-qam', 'caller with available resources');
  git(source, 'branch', 'head');
  git(source, 'update-index', '--cacheinfo', '160000,' + 'f'.repeat(40) + ',resources');
  git(source, 'commit', '-qm', 'historical unavailable submodule');
  const baseline = git(source, 'rev-parse', 'HEAD');
  git(source, 'checkout', '-q', 'head');
  git(root, 'clone', '--bare', '-q', source, remote);

  function checkout(name) {
    const directory = path.join(root, name);
    git(root, 'clone', '-q', '--depth', '1', '-b', 'head', pathToFileURL(remote).href, directory);
    git(directory, '-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q', 'resources');
    git(directory, 'config', 'fetch.recurseSubmodules', 'on-demand');
    assert.notEqual(run(directory, 'git', ['cat-file', '-e', baseline + '^{commit}']).status, 0,
      'fixture baseline must actually be absent before the tested fetch');
    return directory;
  }

  const brokenCheckout = checkout('broken');
  const broken = run(brokenCheckout, 'git', [
    '-c', 'protocol.file.allow=always', 'fetch', '--no-tags', 'origin', baseline,
  ]);
  assert.notEqual(broken.status, 0, broken.stdout);
  assert.match(broken.stderr, /not our ref/);

  // A failed recursive fetch can already have downloaded the commit.
  // Use an independent checkout so the fixed fetch cannot pass by accident.
  const fixedCheckout = checkout('fixed');
  const fixed = run(fixedCheckout, 'bash', [fetchBaseline, baseline]);
  assert.equal(fixed.status, 0, fixed.stderr);
  git(fixedCheckout, 'cat-file', '-e', baseline + '^{commit}');
  assert.equal(git(fixedCheckout, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'head'));

  // The local baseline path must work even if the remote is unavailable.
  git(fixedCheckout, 'remote', 'set-url', 'origin', pathToFileURL(path.join(root, 'missing.git')).href);
  const offline = run(fixedCheckout, 'bash', [fetchBaseline, baseline]);
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stdout, /present locally/);
});
