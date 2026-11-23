import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
function fixture(t, manifest) {
  const root = mkdtempSync(join(tmpdir(), 'ci-language-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tool = join(root, '.fake-tool');
  writeFileSync(tool, '#!/usr/bin/env node\n' +
    "const fs = require('fs'); fs.appendFileSync('.executions', JSON.stringify(process.argv.slice(2)) + '\\n');\n");
  chmodSync(tool, 0o755);
  for (const path of [...(manifest.shell || []), ...(manifest.javascript || []),
    ...(manifest.typescript || [])]) {
    if (path.startsWith('..')) continue;
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'hello');
  }
  const json = join(root, '.manifest.json');
  writeFileSync(json, JSON.stringify({ format: 1, ...manifest }));
  return { root, tool, json };
}
function run(spec, module, extra) {
  const args = [runner, module, spec.json, spec.tool];
  if (extra) args.push(extra);
  return spawnSync('node', args, { cwd: spec.root, encoding: 'utf8' });
}
function invocations(spec) {
  return readFileSync(join(spec.root, '.executions'), 'utf8').trim().split('\n').map(JSON.parse);
}

test('ShellCheck ignores Zsh but checks tracked Bash including space paths', t => {
  const spec = fixture(t, { shell: ['scripts/hello world.sh', 'tools/build.zsh'] });
  assert.equal(run(spec, 'shellcheck').status, 0);
  assert.deepEqual(invocations(spec), [['--severity=warning', '--', 'scripts/hello world.sh']]);
});

test('shfmt parses both shell dialects without writing and enforces format optionally', t => {
  const spec = fixture(t, { shell: ['scripts/a.sh', 'bin/a.zsh'] });
  assert.equal(run(spec, 'shfmt').status, 0);
  assert.deepEqual(invocations(spec), [['./scripts/a.sh'], ['./bin/a.zsh']]);
});

test('JS correctness includes both JS and TS, not untracked files', t => {
  const spec = fixture(t, { javascript: ['web/file.js'], typescript: ['web/client.tsx'], shell: [] });
  assert.equal(run(spec, 'javascript').status, 0);
  assert.deepEqual(invocations(spec), [['-D', 'correctness', '--', 'web/file.js', 'web/client.tsx']]);
});

test('Path traversal fails before invoking tools', t => {
  const spec = fixture(t, { shell: ['../etc/passwd'] });
  const result = run(spec, 'shellcheck');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe tracked source path/);
});

test('Tool failure is fatal, not a best-effort report', t => {
  const spec = fixture(t, { javascript: ['web/file.js'], typescript: [] });
  writeFileSync(spec.tool, '#!/usr/bin/env bash\nexit 7\n');
  assert.equal(run(spec, 'javascript').status, 7);
});

test('No tracked source means no tool process', t => {
  const spec = fixture(t, { shell: [], javascript: [], typescript: [] });
  assert.equal(run(spec, 'shellcheck').status, 0);
  assert.equal(run(spec, 'javascript').status, 0);
});
