import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnointOutput, summarizeAnoint } from './anoint.mjs';
import { releaseUrl, verifyBinary } from './install-anoint.mjs';
import { createHash } from 'node:crypto';

const overlap = { kind: 'CapabilityOverlap', current: 'wreq+reqwest', recommended: 'wreq', reason: 'Potential overlapping HTTP providers.', impact: 'Medium' };
const preference = { kind: 'ModernAlternative', current: 'foo', recommended: 'bar', reason: 'Prefer maintained provider.', impact: 'Low' };
function report(...suggestions) {
  return JSON.stringify({
    cargo_anoint_version: '0.4.1', workspace_scan: true,
    packages: [{ name: 'fixture', version: '0.1.0', manifest_path: '/fixture/Cargo.toml', dependency_suggestions: suggestions }],
  });
}

test('workspace consolidation findings include both conflicts and recommendations', () => {
  const parsed = parseAnointOutput(report(preference, overlap), 0);
  assert.equal(parsed.failed, false);
  assert.equal(parsed.packages, 1);
  assert.deepEqual(parsed.findings.map(f => [f.package, f.kind]), [['fixture', 'ModernAlternative'], ['fixture', 'CapabilityOverlap']]);
  const summary = summarizeAnoint(parsed);
  assert.match(summary.row, /2 \| Review candidates/);
  assert.match(summary.lines.join('\n'), /1 potential capability overlaps, 1 other dependency recommendations/);
  assert.ok(summary.lines.findIndex(l => l.includes('CapabilityOverlap')) < summary.lines.findIndex(l => l.includes('ModernAlternative')));
});

test('clean workspace results require a valid full report', () => {
  assert.equal(parseAnointOutput(report(), 0).failed, false);
  assert.match(summarizeAnoint(parseAnointOutput(report(), 0)).row, /No candidates/);
  for (const raw of ['{}', 'broken', report({ ...overlap, kind: 'Unsupported' }), report(null)]) {
    assert.equal(parseAnointOutput(raw, 0).failed, true);
  }
  assert.equal(parseAnointOutput(report(overlap), null).failed, true);
  assert.equal(parseAnointOutput(report(overlap), 1, 'Error: metadata failed').failed, true);
  assert.equal(parseAnointOutput(report(overlap), 2).failed, true);
});

test('explicit caller failure policy is recorded without treating the scan as unavailable', () => {
  const stderr = 'Error: exiting with non-zero status: potential overlapping dependency providers\n';
  const parsed = parseAnointOutput(report(overlap), 1, stderr);
  assert.equal(parsed.policyTriggered, true);
  assert.equal(parsed.failed, false);
  assert.match(summarizeAnoint(parsed).lines.join('\n'), /own anoint.toml failure policy/);
  assert.equal(parseAnointOutput(report(), 1, stderr).failed, true);
});

test('malicious custom rule text cannot add HTML or Markdown markup to the summary', () => {
  const summary = summarizeAnoint(parseAnointOutput(report({ ...overlap, reason: '<img src=x>\n![image](url)' }), 0));
  const text = summary.lines.join('\n');
  assert.ok(!text.includes('<img'));
  assert.ok(!text.includes('![image]'));
});

test('release URLs are commit-addressed and binary digest verification fails closed', () => {
  const bytes = Buffer.from('test scanner');
  const pin = { commit: 'a'.repeat(40), sha256: createHash('sha256').update(bytes).digest('hex') };
  assert.equal(releaseUrl(pin), 'https://github.com/codeandsolder/cargo-anoint/releases/download/ci-' + pin.commit + '/cargo-anoint-linux-x86_64');
  assert.doesNotThrow(() => verifyBinary(bytes, pin.sha256));
  assert.throws(() => verifyBinary(Buffer.from('changed'), pin.sha256), /checksum mismatch/);
  assert.throws(() => releaseUrl({ ...pin, commit: 'main' }), /Invalid pinned/);
  assert.throws(() => releaseUrl({ ...pin, sha256: '' }), /Invalid pinned/);
});
