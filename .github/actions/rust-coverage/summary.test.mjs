import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function report(json, status = 'success') {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-summary-'));
  try {
    const data = join(dir, 'coverage.json');
    const summary = join(dir, 'summary.md');
    if (json !== undefined) writeFileSync(data, JSON.stringify(json));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./summary.mjs', import.meta.url))], {
      env: {
        ...process.env,
        COVERAGE_JSON: data,
        COVERAGE_STATUS: status,
        COVERAGE_DIRECTORY: 'smoke-cache',
        COVERAGE_ARTIFACT_URL: 'https://github.com/example/actions/runs/123/artifacts/456',
        GITHUB_STEP_SUMMARY: summary,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(summary, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('reports available LLVM metrics and a report link with no gate', () => {
  const output = report({
    data: [{ totals: {
      lines: { count: 20, covered: 17 },
      functions: { count: 10, covered: 9 },
      branches: { count: 0, covered: 0 },
    } }],
  });
  assert.match(output, /Lines \| 17 \| 20 \| 85.0%/);
  assert.match(output, /Functions \| 9 \| 10 \| 90.0%/);
  assert.match(output, /Branches \| 0 \| 0 \| N\/A/);
  assert.match(output, /informational/);
  assert.match(output, /artifacts\/456/);
  assert.doesNotMatch(output, /did not complete successfully/);
});

test('states incomplete coverage without failing the summary', () => {
  const output = report(undefined, 'failure');
  assert.match(output, /did not complete successfully/);
  assert.match(output, /Coverage totals unavailable/);
});

test('rejects impossible coverage totals as unavailable', () => {
  const output = report({ data: [{ totals: { lines: { count: 4, covered: 5 } } }] });
  assert.match(output, /Invalid LLVM coverage totals/);
});
