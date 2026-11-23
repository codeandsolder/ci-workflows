import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const modulePath = path.resolve(process.argv[2] ??
  fileURLToPath(new URL('./module.json', import.meta.url)));
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

test('checklist/labeler agreement via the portable WASM action boundary', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ci-checklist-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  const template = '.github/PULL_REQUEST_TEMPLATE.md';
  const workflow = '.github/workflows/pr-tags.yml';
  const write = (relative, body) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), {recursive:true});
    writeFileSync(target, body);
  };
  const run = (...more) => spawnSync(process.execPath, [
    runner, modulePath, 'checklist-labels', root,
    template, workflow, 'Type of change', 'TYPE_LABELS', ...more,
  ], {encoding:'utf8', maxBuffer:16*1024*1024});

  write(template, '## Type of change\n\n- [ ] Bug fix\n- [ ] Feature\n\n## Summary\n');
  write(workflow, [
    'jobs:',
    '  label:',
    '    steps:',
    '      - uses: actions/github-script@v9',
    '        with:',
    '          script: |',
    '            const TYPE_LABELS = [',
    '              {"text":"Bug fix","label":"bug","color":"d73a4a"},',
    '              {"text":"Feature","label":"enhancement","color":"a2eeef"}',
    '            ];',
    '',
  ].join('\n'));
  const good = run();
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /labels match/);

  write(template, '## Type of change\n\n- [ ] Bug fix\n- [ ] Documentation\n');
  const drift = run();
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /Documentation/);
  assert.match(drift.stderr, /Feature/);

  write(template, '## Type of change\n\n- [ ] Bug fix\n- [ ] Feature\n');
  write(workflow, 'jobs:\n  label:\n    steps:\n      - with:\n          script: |\n            const TYPE_LABELS = [{"text":"Bug fix","label":"bug","color":"oops"}];\n');
  const bad = run();
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /invalid label mapping entry/);
});
