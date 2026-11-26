import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAdvisoryOutput, parseMacheteOutput, summarize } from './run.mjs';
const cleanAnoint = { findings: [], packages: 1, version: '0.4.1', failed: false };

test('RustSec JSON diagnostics and warnings are counted', () => {
  const json = [
    { type: 'diagnostic', fields: { severity: 'error', code: 'vulnerability', message: 'affected crate' } },
    { type: 'diagnostic', fields: { severity: 'warning', code: 'yanked', message: 'yanked version' } },
    { type: 'log', fields: { level: 'INFO', message: 'auditing' } },
  ].map(JSON.stringify).join('\n');
  const report = parseAdvisoryOutput(json, 1);
  assert.equal(report.findings.length, 2);
  assert.equal(report.failed, false);
  assert.match(summarize(report, { findings: [], failed: false }, cleanAnoint), /Review advisories/);
});

test('cargo-deny errors are not silently reported clean', () => {
  const parsed = parseAdvisoryOutput(JSON.stringify({ type: 'log', fields: { level: 'ERROR', message: 'database unreachable' } }), 1);
  assert.equal(parsed.failed, true);
  assert.match(summarize(parsed, { findings: [], failed: false }, cleanAnoint), /Unavailable/);
});

test('cargo machete JSON flags candidates but does not enforce removal', () => {
  const parsed = parseMacheteOutput(JSON.stringify({ crates: [{ package_name: 'app', manifest_path: '/x/Cargo.toml', unused: ['foo'], ignored_used: [] }] }), 1);
  assert.equal(parsed.failed, false);
  assert.deepEqual(parsed.findings.map((x) => x.dependency), ['foo']);
  assert.match(summarize({ findings: [], failed: false }, parsed, cleanAnoint), /Potentially unused dependencies/);
});

test('cargo machete empty results and invalid diagnostics', () => {
  assert.deepEqual(parseMacheteOutput('{}', 0), { findings: [], failed: false });
  assert.equal(parseMacheteOutput('{}', 1).failed, true);
  assert.equal(parseMacheteOutput('broken', 2).failed, true);
});
