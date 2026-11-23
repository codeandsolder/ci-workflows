import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {trackedCargoManifests} from './detect-cargo.mjs';

test('Git-tracked Cargo source drives classification, including nested workspaces', () => {
  const root = mkdtempSync(path.join(tmpdir(),'upstream rust candidate '));
  try {
    const git = (...args) => execFileSync('git',['-C',root,...args], {stdio:'pipe'});
    git('init','-q');
    writeFileSync(path.join(root,'go.mod'), 'module example.test/none\n');
    writeFileSync(path.join(root,'looks_like_Cargo.toml'), '[package]\n');
    git('add','go.mod','looks_like_Cargo.toml');
    assert.deepEqual(trackedCargoManifests(root),[]);

    mkdirSync(path.join(root,'nested'),{recursive:true});
    writeFileSync(path.join(root,'nested','Cargo.toml'),'[package]\nname="example"\nversion="0.1.0"\n');
    assert.deepEqual(trackedCargoManifests(root),[],'untracked generated Cargo manifest is not source');
    git('add','nested/Cargo.toml');
    assert.deepEqual(trackedCargoManifests(root),['nested/Cargo.toml']);
    writeFileSync(path.join(root,'Cargo.toml'),'[workspace]\n');
    git('add','Cargo.toml');
    assert.deepEqual(trackedCargoManifests(root),['Cargo.toml','nested/Cargo.toml']);
    git('rm','--cached','-q','Cargo.toml');
    assert.deepEqual(trackedCargoManifests(root),['nested/Cargo.toml']);

    const output = path.join(root,'.github-output');
    const script = fileURLToPath(new URL('./detect-cargo.mjs',import.meta.url));
    execFileSync(process.execPath,[script,root,output]);
    assert.equal(readFileSync(output,'utf8'),'rust=true\n');
    git('rm','--cached','-q','nested/Cargo.toml');
    execFileSync(process.execPath,[script,root,output]);
    assert.equal(readFileSync(output,'utf8'),'rust=true\nrust=false\n');
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
