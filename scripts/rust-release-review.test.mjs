import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchRelease, parseRelease, queueRelease, reviewBody } from './rust-release-review.mjs';

const release = {version: '1.100.0', date: '2026-11-12'};
const manifest = 'manifest-version = "2"\ndate = "2026-11-12"\n[pkg.cargo]\nversion = "0.101.0"\n[pkg.rust]\nversion = "1.100.0 (abcdef 2026-11-10)"\n[pkg.rust.target.x86_64-unknown-linux-gnu]\nversion = "9.9.9"\n';
test('read only stable Rust fields, including CRLF and comments', () => {
  assert.deepEqual(parseRelease(manifest), release);
  assert.deepEqual(parseRelease(manifest.replaceAll('\n', '\r\n')), release);
  for (const bad of [
    manifest.replace('2026-11-12', '2026-02-31'),
    manifest.replace('1.100.0', 'nightly'),
    manifest.replace('[pkg.rust]', '[pkg.other]'),
    manifest + '[pkg.rust]\nversion = "1.101.0"\n',
    'date = "2026-11-12"\n' + manifest,
  ]) assert.throws(() => parseRelease(bad));
});
test('HTTP error fails closed', async () => {
  await assert.rejects(fetchRelease(async () => new Response('', {status: 503})));
  assert.deepEqual(await fetchRelease(async () => new Response(manifest)), release);
});
test('immutable existing issue on later page wins; PRs and other markers ignored', () => {
  const calls = [];
  const gh = args => {
    calls.push(args);
    return args[0] === 'api' ? JSON.stringify([[{number: 1, body: null},
      {number: 2, body: '<!-- rust-stable-1.100.0 -->', pull_request: {}},
      {number: 3, body: '<!-- rust-stable-1.100.01 -->'}],
      [{number: 4, body: '<!-- rust-stable-1.100.0 -->'}]]) : '';
  };
  assert.deepEqual(queueRelease('owner/repo', release, gh), {existing: 4});
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('--paginate'));
  assert.ok(calls[1].includes('state=all'));
});
test('new release creates exactly one issue and retains automation markers', () => {
  const calls = [];
  const gh = args => {
    calls.push(args);
    return args[0] === 'api' ? '[[]]' : 'https://github.com/owner/repo/issues/1\n';
  };
  assert.deepEqual(queueRelease('owner/repo', release, gh), {created: 'https://github.com/owner/repo/issues/1'});
  assert.equal(calls.length, 3);
  assert.equal(calls[2][0], 'issue');
  assert.equal(calls[2].at(-1), reviewBody(release.version));
  assert.match(calls[2].at(-1), /automation-queue:rust-release/);
  assert.match(calls[2].at(-1), /quarantined nightly/);
});
test('bad input and failed inventory cannot create issues', () => {
  let calls = 0;
  const gh = () => { calls++; throw new Error('unexpected'); };
  assert.throws(() => queueRelease('owner/repo', {...release, version: 'nightly'}, gh));
  assert.throws(() => queueRelease('bad', release, gh));
  assert.equal(calls, 0);
  assert.throws(() => queueRelease('owner/repo', release, args => {
    calls++;
    if (args[0] === 'api') throw new Error('inventory unavailable');
  }));
  assert.equal(calls, 2);
});
