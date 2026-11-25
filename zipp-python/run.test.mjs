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

test('binary and scratch VFS files preserve bytes without publishing scratch writes', async t => {
  const root = fixture(t, 'from pathlib import Path\nassert Path("data.bin").read_bytes() == bytes([0, 255, 128, 1])\nPath("scratch").mkdir()\nPath("scratch/result.txt").write_text("ephemeral")\n');
  writeFileSync(path.join(root,'data.bin'),Buffer.from([0,255,128,1]));
  await runTask(root,{entry:'main.py',read:['data.bin'],scratch:['scratch/**']},[]);
  assert.equal(existsSync(path.join(root,'scratch')),false);
});

test('git metadata cannot be read or written even through task configuration', async t => {
  const root = fixture(t,'print("not reached")');
  mkdirSync(path.join(root,'.git'));
  writeFileSync(path.join(root,'.git/config'),'not for guest');
  await assert.rejects(runTask(root,{entry:'main.py',read:['.git/config']},[]),/invalid checkout-relative path/);
});

test('a declared stdin stream becomes one explicit virtual input file', async t => {
  const root = fixture(t,'from pathlib import Path\nassert Path("stdin.json").read_text() == \'{"message":"hello"}\'\n');
  await runTask(root,{entry:'main.py',stdin:'stdin.json'},[],undefined,Buffer.from('{"message":"hello"}'));
  assert.equal(existsSync(path.join(root,'stdin.json')),false);
  await assert.rejects(runTask(root,{entry:'main.py',stdin:'stdin.json'},[]),/invalid or colliding/);
  await assert.rejects(runTask(root,{entry:'main.py'},[],undefined,Buffer.from('x')),/no declared stdin/);
});

test('Python 0.0.38 stdlib covers portable policy oracles and real ZIP DEFLATE', async t => {
  const root = fixture(t, [
    'import datetime',
    'import importlib.util',
    'import shlex',
    'import tomllib',
    'import unittest',
    'import unittest.mock',
    'import zipfile',
    'from pathlib import Path',
    'assert tomllib.loads("age = 72\\n[policy]\\nstrict = true\\n") == {"age": 72, "policy": {"strict": True}}',
    'assert shlex.split("cargo example two # comment", comments=True) == ["cargo", "example", "two"]',
    'stamp = datetime.datetime.fromisoformat("2026-11-23T05:42:27+00:00")',
    'assert stamp.tzinfo is not None',
    'assert (stamp - datetime.timedelta(hours=72)).date().isoformat() == "2026-11-20"',
    'assert importlib.util.spec_from_file_location is not None',
    'class Target: value = 3',
    'with unittest.mock.patch.object(Target, "value", 8):',
    '    assert Target.value == 8',
    'assert Target.value == 3',
    'assert Path("crlf.txt").read_text() == "first\\nsecond\\nthird\\n"',
    'info = zipfile.ZipInfo("data.txt", (1980, 1, 1, 0, 0, 0))',
    'info.compress_type = zipfile.ZIP_DEFLATED',
    'with zipfile.ZipFile("probe.zip", "w") as archive:',
    '    archive.writestr(info, b"compress me" * 2000, compresslevel=9)',
    'with zipfile.ZipFile("probe.zip") as archive:',
    '    entry = archive.getinfo("data.txt")',
    '    assert entry.compress_type == zipfile.ZIP_DEFLATED',
    '    assert entry.compress_size < entry.file_size',
    '    assert archive.read("data.txt") == b"compress me" * 2000',
  ].join('\n'));
  writeFileSync(path.join(root, 'crlf.txt'), 'first\r\nsecond\rthird\n');
  await runTask(root, {entry: 'main.py', read: ['crlf.txt'], scratch: ['probe.zip']}, []);
  assert.equal(existsSync(path.join(root, 'probe.zip')), false);
});

test('Python explicit script entry may live below a non-identifier directory', async t => {
  const root = fixture(t, 'print("unused")');
  mkdirSync(path.join(root, 'fixtures/with-hyphen'), {recursive: true});
  writeFileSync(path.join(root, 'fixtures/with-hyphen/check.py'), 'print("arbitrary script path works")\n');
  const output = [];
  await runTask(root, {entry: 'fixtures/with-hyphen/check.py'}, [], row => output.push(row));
  assert.deepEqual(output, [{stream: 'stdout', text: 'arbitrary script path works'}]);
});
