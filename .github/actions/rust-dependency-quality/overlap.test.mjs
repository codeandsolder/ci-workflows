import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./overlap.mjs', import.meta.url));

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), 'dependency-overlap-test-'));
  const root = join(temp, 'caller');
  const bin = join(temp, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  writeFileSync(join(root, 'Cargo.toml'), '[workspace]\n');
  const output = join(temp, 'outputs');
  const summary = join(temp, 'summary');
  const started = join(temp, 'started');
  const release = join(temp, 'release');
  writeFileSync(join(bin, 'cargo-deny'), '#!/usr/bin/env bash\nset -euo pipefail\ntouch "$SCAN_STARTED"\nwhile [[ ! -e "$SCAN_RELEASE" ]]; do sleep 0.05; done\n', {mode:0o755});
  const anoint = join(bin, 'cargo-anoint');
  writeFileSync(anoint, '#!/usr/bin/env bash\nprintf "%s\\n" "$SCAN_ANOINT_JSON"\nexit "$SCAN_ANOINT_STATUS"\n', {mode:0o755});
  writeFileSync(join(bin, 'cargo-machete'), '#!/usr/bin/env bash\nprintf "{}\\n"\n', {mode:0o755});
  const env = {
    ...process.env, RUNNER_TEMP:temp, GITHUB_WORKSPACE:root,
    GITHUB_OUTPUT:output, GITHUB_STEP_SUMMARY:summary,
    DEPENDENCY_DIRECTORIES:'["."]', DEPENDENCY_SCANNERS_INSTALLED:'success',
    DEPENDENCY_ANOINT_BINARY:anoint, PATH:bin + ':' + process.env.PATH,
    SCAN_ANOINT_JSON:JSON.stringify({cargo_anoint_version:'test',workspace_scan:true,packages:[{name:'fixture',version:'0.1.0',manifest_path:join(root,'Cargo.toml'),dependency_suggestions:[]}]}),
    SCAN_ANOINT_STATUS:'0',
    SCAN_STARTED:started, SCAN_RELEASE:release,
  };
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args], {env, encoding:'utf8', timeout:10_000});
  let state;
  t.after(() => {
    if (state && existsSync(state)) invoke('finish',state,'false');
    rmSync(temp,{recursive:true,force:true});
  });
  return {
    output, summary, started, release, invoke, env,
    start() {
      const result = invoke('start');
      assert.equal(result.status,0,result.stderr);
      state = readFileSync(output,'utf8').trim().split('=')[1];
      assert(existsSync(state));
      return state;
    },
  };
}

async function waitForFile(path) {
  for (let attempt=0; attempt<100; attempt++) {
    if (existsSync(path)) return;
    await delay(20);
  }
  assert.fail('worker did not start scanner: ' + path);
}

test('launch returns while a real scanner subprocess is blocked, then collects its report', async t => {
  const f = fixture(t);
  const state = f.start();
  await waitForFile(f.started);
  assert(!existsSync(join(state,'status.json')));
  // Simulate required validation executing while the advisory scan is active.
  writeFileSync(f.release,'');
  const result = f.invoke('finish',state,'true');
  assert.equal(result.status,0,result.stderr);
  const report = join(state,'report');
  assert.match(readFileSync(f.output,'utf8'), /report-root=/);
  assert.deepEqual(JSON.parse(readFileSync(join(report,'run-status.json'),'utf8')), {status:'success'});
  const data = JSON.parse(readFileSync(join(report,'workspace-0','results.json'),'utf8'));
  assert.equal(data.installed,true);
  assert.equal(data.audit.failed,false);
  assert.equal(data.unused.failed,false);
  assert.match(readFileSync(f.summary,'utf8'), /Rust dependency health/);
});

test('failed mandatory validation cancels an active scanner and removes state without publication', async t => {
  const f = fixture(t);
  const state = f.start();
  await waitForFile(f.started);
  const {pid} = JSON.parse(readFileSync(join(state,'worker.json'),'utf8'));
  const result = f.invoke('finish',state,'false');
  assert.equal(result.status,0,result.stderr);
  assert(!existsSync(state));
  assert(!existsSync(f.summary));
  assert(!readFileSync(f.output,'utf8').includes('report-root='));
  if (existsSync('/proc/'+pid+'/cmdline')) {
    assert(!readFileSync('/proc/'+pid+'/cmdline','utf8').includes(state));
  }
});

test('refuse state paths outside the exact runner-owned scan directory', t => {
  const f = fixture(t);
  const result = f.invoke('finish',dirname(f.output),'false');
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Invalid runner-local dependency scan state/);
});


test('unavailable scanner and unresolved focused overlap fail collection after publishing diagnostics', async t => {
  for (const mode of ['unavailable','conflict']) {
    const f = fixture(t);
    if (mode === 'unavailable') f.env.DEPENDENCY_ANOINT_BINARY = '';
    else {
      const report = JSON.parse(f.env.SCAN_ANOINT_JSON);
      report.packages[0].dependency_suggestions.push({kind:'CapabilityOverlap',current:'wreq+reqwest',recommended:'wreq',reason:'overlap',impact:'Medium'});
      f.env.SCAN_ANOINT_JSON = JSON.stringify(report);
    }
    const state = f.start();
    await waitForFile(f.started);
    writeFileSync(f.release,'');
    const result = f.invoke('finish',state,'true');
    assert.notEqual(result.status,0);
    assert.match(readFileSync(f.output,'utf8'), /report-root=/);
    const status = JSON.parse(readFileSync(join(state,'report','run-status.json'),'utf8'));
    assert.equal(status.status,'failed');
    assert.match(status.reason, /Dependency gate failed/);
    assert(existsSync(join(state,'report','workspace-0','results.json')));
  }
});
