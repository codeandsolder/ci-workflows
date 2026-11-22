import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseToolchain, latestCandidate, nightlyDate, publication, publicationTime, readPin, requireAge } from '../.github/actions/resolve-rust-toolchain/select.mjs';
const now = Date.parse('2026-11-22T13:00:00Z');
const pin = 'nightly-2026-11-12';
const candidate = 'nightly-2026-11-19';
const published = Date.parse('2026-11-19T13:00:00Z');

test('literal dated manifest pin and strict calendar validation', () => {
  assert.equal(readPin('# hi\n[toolchain]\nchannel = "nightly-2026-11-19" # pinned\nprofile = "minimal"\n'), candidate);
  assert.equal(readPin("[toolchain]\r\nchannel = 'nightly-2026-11-19'\r\n[other]\r\nchannel='stable'"), candidate);
  for (const value of ['nightly','stable','nightly-2026-11-31','nightly-2026-02-29','nightly-2026-11-19-extra']) {
    assert.throws(() => nightlyDate(value));
  }
  assert.throws(() => readPin('[toolchain]\nprofile = "minimal"'));
  assert.throws(() => readPin('[toolchain]\nchannel = "stable"\nchannel = "nightly"'));
});
test('routine compile and lint consume same repository pin; release exceptions are explicit', () => {
  const base = { tier: 'routine', requested: '', caller: candidate, fleet: pin };
  assert.equal(chooseToolchain(base), candidate);
  assert.throws(() => chooseToolchain({...base, caller: null}), /requires a root/);
  assert.throws(() => chooseToolchain({...base, tier: 'release', caller: null}), /requires/);
  assert.throws(() => chooseToolchain({...base, caller: 'stable'}));
  assert.throws(() => chooseToolchain({...base, requested: pin}));
  assert.equal(chooseToolchain({...base, tier: 'release', requested: '1.100.0'}), '1.100.0');
});
test('quarantine is 72 elapsed hours, not three calendar dates', async () => {
  assert.equal(await requireAge(candidate, now, async () => published), published);
  await assert.rejects(requireAge(candidate, now, async () => published + 1), /72-hour/);
  await assert.rejects(requireAge(candidate, now, async () => null), /unavailable/);
  for (const header of [null, 'invalid', 'Wed, 18 Nov 2026 23:59:59 GMT', 'Mon, 23 Nov 2026 00:00:00 GMT']) {
    assert.throws(() => publicationTime(candidate, header, now));
  }
});
test('candidate discovery skips absent and young manifests and waits a week between dates', async () => {
  assert.equal(await latestCandidate(pin, now, async () => published), candidate);
  assert.equal(await latestCandidate(pin, now, async () => published + 1), null);
  assert.equal(await latestCandidate('nightly-2026-11-11', now, async channel => channel === candidate ? null : Date.parse('2026-11-18T03:00:00Z')), 'nightly-2026-11-18');
  assert.equal(await latestCandidate('nightly-2026-11-15', now, async () => {throw Error('must not call');}), null);
});
test('manifest HTTP errors and missing header fail closed', async () => {
  assert.equal(await publication(candidate, now, async () => new Response(null, {status: 404})), null);
  await assert.rejects(publication(candidate, now, async () => new Response(null, {status: 500})), /HTTP 500/);
  await assert.rejects(publication(candidate, now, async () => new Response(null, {status: 200})), /timestamp/);
});
