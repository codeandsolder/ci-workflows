import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gather, guest, quarantine, lookupPublications } from './quarantine.mjs';

const module = path.resolve(process.argv[2] ?? fileURLToPath(new URL('./module.json', import.meta.url)));
const source = 'registry+https://github.com/rust-lang/crates.io-index';
const lock = (...packages) => 'version = 4\n' + packages.map(([name, version, registry = source]) =>
  '\n[[package]]\nname = ' + JSON.stringify(name) + '\nversion = ' + JSON.stringify(version) +
  '\nsource = ' + JSON.stringify(registry) + '\n').join('');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'quarantine-wasi-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'});
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  function write(file, value) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), {recursive: true});
    writeFileSync(full, value);
  }
  function remove(file) { unlinkSync(path.join(root, file)); }
  function baseline() {
    git('add', '-A');
    git('commit', '-qm', 'baseline');
    return git('rev-parse', 'HEAD').trim();
  }
  function diff(ref, selector = 'auto') {
    return guest(module, root, 'quarantine-diff', gather(root, ref, selector));
  }
  return {root, git, write, remove, baseline, diff};
}

test('tracked union accounts for moved and nested lockfiles, but not first-party Git revisions', (t) => {
  const f = fixture(t);
  f.write('a/Cargo.lock', lock(['serde', '1.0.0']));
  f.write('Cargo.lock', lock(['own', '0.1.0', 'git+https://github.com/codeandsolder/own#old']));
  const base = f.baseline();
  f.remove('a/Cargo.lock');
  f.write('b/Cargo.lock', lock(['serde', '1.0.0'], ['zstd', '0.9.2']));
  f.write('Cargo.lock', lock(['own', '0.1.0', 'git+https://github.com/codeandsolder/own#new'], ['zstd', '0.9.2']));
  f.write('untracked/Cargo.lock', lock(['untracked', '1.0.0']));
  f.git('add', '-A', 'a', 'b', 'Cargo.lock');
  assert.deepEqual(f.diff(base), [{name: 'zstd', version: '0.9.2', source}]);
});

test('explicit lockfile selection handles missing, generated, and deleted files', (t) => {
  const f = fixture(t);
  f.write('record.txt', lock(['serde', '1.0.0']));
  const base = f.baseline();
  assert.deepEqual(f.diff(base, 'not-present.lock'), []);
  f.write('generated.lock', lock(['serde', '1.0.1']));
  assert.deepEqual(f.diff(base, 'generated.lock'), [{name: 'serde', version: '1.0.1', source}]);
  f.remove('record.txt');
  assert.throws(() => f.diff(base, 'record.txt'), /explicitly selected lockfile/);
  assert.throws(() => f.diff(base, '../outside'), /repository-relative/);
  assert.throws(() => f.diff('does-not-exist'), /rev-parse/);
});

test('removed live workspace requires genuine tracked workspace membership', (t) => {
  const f = fixture(t);
  f.write('package/Cargo.toml', "[package]\nname='example'\nversion='0.1.0'\nedition='2024'\n");
  f.write('package/src/lib.rs', '');
  f.write('package/Cargo.lock', lock(['serde', '1.0.0']));
  const base = f.baseline();
  f.remove('package/Cargo.lock');
  assert.throws(() => f.diff(base), /still exists/);
  f.write('Cargo.toml', "[workspace]\nmembers=[]\nexclude=['package']\nresolver='3'\n");
  f.write('Cargo.lock', lock(['serde', '1.0.0']));
  f.git('add', '-A');
  assert.throws(() => f.diff(base), /still exists/);
  f.write('Cargo.toml', "[workspace]\nmembers=['package']\nresolver='3'\n");
  f.git('rm', '--cached', 'Cargo.lock');
  assert.throws(() => f.diff(base), /still exists/);
  f.write('Cargo.lock', lock(['serde', '1.0.0'], ['zstd', '0.9.2']));
  f.git('add', '-A');
  assert.deepEqual(f.diff(base), [{name: 'zstd', version: '0.9.2', source}]);
  f.remove('package/Cargo.toml');
  assert.deepEqual(f.diff(base), [{name: 'zstd', version: '0.9.2', source}]);
});

test('symlinked lockfile fails closed', (t) => {
  const f = fixture(t);
  f.write('target.lock', lock(['serde', '1.0.0']));
  const base = f.baseline();
  try {
    symlinkSync('target.lock', path.join(f.root, 'Cargo.lock'));
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip('host cannot create symlinks');
      return;
    }
    throw error;
  }
  f.git('add', '-A');
  assert.throws(() => f.diff(base), /symlinked/);
  assert.throws(() => f.diff(base, 'Cargo.lock'), /symlinked/);
});

test('publication timestamps, lookup caching, and missing metadata fail closed', async (t) => {
  const f = fixture(t);
  f.write('Cargo.lock', lock(['serde', '1.0.0']));
  const base = f.baseline();
  f.write('Cargo.lock', lock(['serde', '1.0.1'], ['serde', '1.0.2'], ['serde', '1.0.3']));
  const now = Date.parse('2026-11-22T00:00:00Z');
  let requests = 0;
  const response = async (url) => {
    requests += 1;
    assert.equal(url, 'https://crates.io/api/v1/crates/serde');
    return {ok: true, json: async () => ({versions: [
      {num: '1.0.1', created_at: '2026-11-19T00:00:00Z'},
      {num: '1.0.2', created_at: '2026-11-19T00:00:00.000001Z'},
    ]})};
  };
  const result = await quarantine(module, f.root, base, 'auto', 72, response, now);
  assert.equal(requests, 1);
  assert.equal(result.count, 3);
  assert.equal(result.issues.length, 2);
  assert.equal(result.metadataUnavailable, true);
  assert.match(result.issues[0], /1.0.2.*younger than 72h/);
  assert.match(result.issues[1], /1.0.3.*missing authoritative/);
  const failed = await quarantine(module, f.root, base, 'auto', 72, async () => { throw new Error('offline'); }, now, fakeTransport().transport);
  assert.equal(failed.metadataUnavailable, true);
  assert.equal(failed.issues.length, 3);
  assert.ok(failed.issues.every((issue) => issue.includes('crates.io lookup failed')));
  const malformed = await quarantine(module, f.root, base, 'auto', 72,
    async () => ({ok: true, json: async () => ({versions: [{num: '1.0.1', created_at: 'not a time'}]})}), now);
  assert.match(malformed.issues[0], /invalid publication timestamp/);
  f.write('Cargo.lock', lock(['serde', '1.0.0']));
  assert.deepEqual(await quarantine(module, f.root, base, 'auto', 72, async () => {
    throw new Error('unchanged packages must not reach network');
  }, now), {issues: [], count: 0, metadataUnavailable: false});
});


test('fully deleted workspace and repositories without lockfiles require no quarantine', async (t) => {
  const f = fixture(t);
  f.write('package/Cargo.toml', '[workspace]\n');
  f.write('package/Cargo.lock', lock(['serde', '1.0.0']));
  const base = f.baseline();
  f.remove('package/Cargo.toml');
  f.remove('package/Cargo.lock');
  f.git('add', '-A');
  assert.deepEqual(f.diff(base), []);

  const empty = fixture(t);
  empty.write('README.md', 'No Cargo workspaces.');
  const initial = empty.baseline();
  assert.deepEqual(empty.diff(initial), []);
  const result = await quarantine(module, empty.root, initial, 'auto', 72, async () => {
    throw Error('unchanged empty repository must not query crates.io');
  });
  assert.deepEqual(result, {issues: [], count: 0, metadataUnavailable: false});
});

test('untracked lockfile cannot silently replace a tracked workspace member lock', (t) => {
  const f = fixture(t);
  f.write('package/Cargo.toml',
    "[package]\nname='example'\nversion='0.1.0'\nedition='2024'\n");
  f.write('package/src/lib.rs', '');
  f.write('package/Cargo.lock', lock(['serde', '1.0.0']));
  const base = f.baseline();
  f.remove('package/Cargo.lock');
  f.write('Cargo.toml', "[workspace]\nmembers=['package']\nresolver='3'\n");
  f.git('add', '-A');
  f.write('Cargo.lock', lock(['serde', '1.0.0']));
  assert.throws(() => f.diff(base), /still exists/);
  f.remove('Cargo.lock');
  f.write('other/Cargo.lock', lock(['serde', '1.0.0']));
  f.git('add', '-A');
  try {
    symlinkSync('other/Cargo.lock', path.join(f.root, 'Cargo.lock'));
    assert.throws(() => f.diff(base), /still exists/);
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    t.diagnostic('host cannot create symlinks; untracked replacement already rejected');
  }
});

test('first-party Git-only revisions never require crates.io, new external versions do', async (t) => {
  const f = fixture(t);
  const own = revision => 'git+https://github.com/codeandsolder/own#' + revision;
  f.write('Cargo.lock', lock(['own', '0.1.0', own('a'.repeat(40))], ['serde', '1.0.0']));
  const base = f.baseline();
  f.write('Cargo.lock', lock(['own', '0.1.0', own('b'.repeat(40))], ['serde', '1.0.0']));
  assert.deepEqual(await quarantine(module, f.root, base, 'auto', 72, async () => {
    throw Error('first-party Git-only update incorrectly performed a crates.io lookup');
  }), {issues: [], count: 0, metadataUnavailable: false});

  f.write('Cargo.lock', lock(['own', '0.1.0', own('b'.repeat(40))], ['serde', '1.0.1']));
  const now = Date.parse('2026-11-23T00:00:00Z');
  let requests = 0;
  const result = await quarantine(module, f.root, base, 'auto', 72, async url => {
    requests++;
    assert.equal(url, 'https://crates.io/api/v1/crates/serde');
    return {ok: true, json: async () => ({versions: [
      {num:'1.0.1', created_at:'2026-11-22T00:00:00Z'},
    ]})};
  }, now);
  assert.equal(requests, 1);
  assert.equal(result.count, 1);
  assert.equal(result.issues.length, 1);
  assert.match(result.issues[0], /serde 1.0.1.*younger than 72h/);
});

function fakeTransport(budgetMs = 480_000) {
  let time = Date.parse('2026-11-26T00:00:00Z');
  const waits = [];
  return {
    waits,
    transport: {clock: () => time, sleep: async ms => { waits.push(ms); time += ms; },
      spacingMs: 1_000, budgetMs},
  };
}

test('one authoritative request per crate and pacing across a large lockfile', async () => {
  const {transport, waits} = fakeTransport();
  const packages = Array.from({length: 150}, (_, i) => ({name: 'crate-' + i, version: '1.0.0'}));
  packages.push(...packages.map(pkg => ({...pkg, version:'1.0.1'})));
  let calls = 0;
  const result = await lookupPublications(packages, async () => {
    calls++;
    return {ok:true, json: async () => ({versions: [
      {num:'1.0.0', created_at:'2026-01-01T00:00:00Z'},
      {num:'1.0.1', created_at:'2026-01-02T00:00:00Z'},
    ]})};
  }, transport);
  assert.equal(calls, 150);
  assert.equal(waits.length, 149);
  assert.ok(waits.every(ms => ms === 1_000));
  assert.equal(result['crate-149']['1.0.1'].kind, 'found');
});

test('429 Retry-After seconds and HTTP date control shared cooldown', async () => {
  const {transport, waits} = fakeTransport();
  const packages = [{name:'a', version:'1'}, {name:'b', version:'1'}];
  const rateLimited = retry => ({ok:false,status:429,headers:new Headers({'Retry-After':retry})});
  const responses = [
    rateLimited('3'),
    rateLimited(new Date(transport.clock()+8_000).toUTCString()),
    {ok:true,json:async()=>({versions:[{num:'1',created_at:'2026-01-01T00:00:00Z'}]})},
    {ok:false,status:404},
  ];
  const result = await lookupPublications(packages, async () => responses.shift(), transport);
  assert.deepEqual(waits,[3_000,5_000,1_000]);
  assert.equal(result.a['1'].kind,'found');
  assert.match(result.b['1'].message,/404/);
  assert.equal(responses.length,0);
});

test('exhausted server cooldown fails closed without hammering other crates', async () => {
  const {transport, waits} = fakeTransport(10_000);
  let calls = 0;
  const result = await lookupPublications([{name:'a',version:'1'},{name:'b',version:'1'}],
    async () => {
      calls++;
      return {ok:false,status:429,headers:new Headers({'Retry-After':'120'})};
    }, transport);
  assert.equal(calls,1);
  assert.deepEqual(waits,[]);
  assert.match(result.a['1'].message,/budget exhausted/);
  assert.match(result.b['1'].message,/budget exhausted/);
});

test('large initial lockfile receives a bounded paced request budget', async () => {
  const {transport, waits} = fakeTransport();
  delete transport.budgetMs;
  const packages = Array.from({length: 800}, (_, i) => ({name: 'crate-' + i, version: '1'}));
  let calls = 0;
  // Use the production budget function with a deterministic clock.
  const result = await lookupPublications(packages, async () => {
    calls++;
    return {ok:true, json: async () => ({versions:[{num:'1',created_at:'2026-01-01T00:00:00Z'}]})};
  }, transport);
  assert.equal(calls, 800);
  assert.equal(waits.length, 799);
  assert.equal(result['crate-799']['1'].kind, 'found');
});
