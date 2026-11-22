import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTask } from './run.mjs';

function fixture(t, source) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'zipp-python-'));
  t.after(() => rmSync(root, {recursive:true, force:true}));
  mkdirSync(path.join(root, '.github'));
  writeFileSync(path.join(root, '.github/policy.txt'), 'policy\n');
  writeFileSync(path.join(root, 'main.py'), source);
  return root;
}

test('hidden file and argument passing; guest writes and deletion applied only on success', async t => {
  const root = fixture(t, [
    'from pathlib import Path',
    'import sys',
    'assert sys.argv == ["main.py", "hello"]',
    'assert Path(".github/policy.txt").read_text() == "policy\\n"',
    'Path("out.txt").write_text("hello")',
    'Path("old.txt").unlink()',
    'print("ok")',
  ].join('\n'));
  writeFileSync(path.join(root,'old.txt'), 'old');
  const output = [];
  await runTask(root, {entry:'main.py', read:['.github/policy.txt','old.txt'], write:['old.txt','out.txt']}, ['hello'], row => output.push(row));
  assert.deepEqual(output,[{stream:'stdout', text:'ok'}]);
  assert.equal(readFileSync(path.join(root,'out.txt'),'utf8'),'hello');
  assert.equal(existsSync(path.join(root,'old.txt')),false);
});

test('undeclared write rejected before any declared write is published', async t => {
  const root = fixture(t, 'from pathlib import Path\nPath("good.txt").write_text("yes")\nPath("bad.txt").write_text("no")\n');
  await assert.rejects(runTask(root,{entry:'main.py', write:['good.txt']},[]),/undeclared/);
  assert.equal(existsSync(path.join(root,'good.txt')),false);
  assert.equal(existsSync(path.join(root,'bad.txt')),false);
});

test('exceptions, including nonzero SystemExit, propagate and do not publish writes', async t => {
  const root = fixture(t, 'from pathlib import Path\nPath("good.txt").write_text("yes")\nraise SystemExit(4)\n');
  await assert.rejects(runTask(root,{entry:'main.py', write:['good.txt']},[]),/SystemExit: 4/);
  assert.equal(existsSync(path.join(root,'good.txt')),false);
});

test('missing inputs and symlinks fail closed', async t => {
  const root = fixture(t,'print("not reached")');
  await assert.rejects(runTask(root,{entry:'main.py',read:['absent.txt']},[]),/required input/);
  try {
    symlinkSync('main.py',path.join(root,'link.py'),'file');
  } catch (error) {
    if (['EPERM','EACCES'].includes(error.code)) return t.skip('symlinks unavailable');
    throw error;
  }
  await assert.rejects(runTask(root,{entry:'main.py',read:['link.py']},[]),/refusing symlink/);
});
