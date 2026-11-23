import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/concurrency.json', import.meta.url), 'utf8'));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const modulePath = process.argv[2] ?? fileURLToPath(new URL('./module.json', import.meta.url));

function normalized(errors) {
  return errors.map(line => line.replaceAll('\\', '/').replace(/: invalid YAML:[\s\S]*/, ': invalid YAML')).sort();
}

test('frozen independent workflow-concurrency oracle cases run on actual shared WASI', () => {
  assert.equal(fixtures.format, 1);
  assert.equal(fixtures.cases.length, 56);
  assert.equal(fixtures.cases.filter(c => !c.expected_errors.length).length, 25);
  assert.equal(fixtures.cases.filter(c => c.expected_errors.length).length, 31);
  for (const [index, item] of fixtures.cases.entries()) {
    const root = mkdtempSync(join(tmpdir(), 'wasm-concurrency-'));
    try {
      const dir = join(root, '.github', 'workflows');
      mkdirSync(dir, {recursive:true});
      for (const [filename, body] of Object.entries(item.files)) {
        assert.match(filename, /^[A-Za-z0-9._-]+\.ya?ml$/);
        writeFileSync(join(dir, filename), body, 'utf8');
      }
      const result = spawnSync(process.execPath, [runner, modulePath, 'concurrency', root], {
        encoding:'utf8', maxBuffer: 4 * 1024 * 1024,
      });
      assert.ifError(result.error);
      const actual = result.stdout.split(/\r?\n/).filter(s => s.startsWith('- ')).map(s => s.slice(2));
      assert.equal(result.status, item.expected_errors.length ? 1 : 0,
        'fixture ' + index + ' status: ' + result.stdout + '\n' + result.stderr);
      assert.deepEqual(normalized(actual), normalized(item.expected_errors),
        'fixture ' + index + ': ' + JSON.stringify(item.files));
      if (item.expected_substring !== null) {
        assert.ok(actual.some(error => error.includes(item.expected_substring)),
          'fixture ' + index + ' missing expected substring ' + item.expected_substring);
      }
    } finally {
      rmSync(root, {recursive:true,force:true});
    }
  }
});
