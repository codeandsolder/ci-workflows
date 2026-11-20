import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('fake GitHub API: dry run is passive, apply reruns only eligible quarantine job', () => {
  const root = mkdtempSync(join(tmpdir(), 'renovate-recheck-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const now = new Date(Date.now() - 4 * 86_400_000).toISOString();
    const stub = join(bin, 'gh');
    writeFileSync(stub, [
      '#!/usr/bin/env node',
      "const fs=require('node:fs');",
      "const args=process.argv.slice(2);",
      "const path=args.at(-1);",
      "fs.appendFileSync(process.env.FAKE_GH_CALLS,args.join(' ')+'\\n');",
      "const json=x=>process.stdout.write(JSON.stringify(x));",
      "const variant=process.env.FAKE_VARIANT||'single';",
      "const check=(id,name)=>({id,name,app:{slug:'github-actions'},status:'completed',conclusion:'failure'});",
      "if(path==='repos/demo/repo/pulls?state=open&per_page=100&page=1') json([{ number:1, state:'open', user:{login:'renovate[bot]'}, head:{sha:'abc'} }]);",
      "else if(path==='repos/demo/repo/commits/abc/check-runs?per_page=100&page=1') json({check_runs:variant==='single'?[check(123,'Custom Rust validation')]:[check(123,'Custom Rust validation'),check(124,'Another Rust workspace')]});",
      "else if(path==='repos/demo/repo/actions/jobs/123'||path==='repos/demo/repo/actions/jobs/124') { const id=Number(path.split('/').at(-1)); json({id,run_id:444,status:'completed',conclusion:'failure',head_sha:'abc',run_attempt:1,steps:[{name:id===124&&variant==='mixed'?'Clippy':'Quarantine newly introduced crates.io versions across all workspaces',conclusion:'failure'}]}); }",
      "else if(path==='repos/demo/repo/actions/jobs/123/logs'||path==='repos/demo/repo/actions/jobs/124/logs') process.stdout.write('Cargo release-age quarantine is still active:\\n- abc 1.0.0: published '+(path.includes('/124/')&&variant==='young'?new Date().toISOString():'"+now+"')+', younger than 72h\\n');",
      "else if(path==='repos/demo/repo/pulls/1') json({state:'open',head:{sha:'abc'}});",
      "else if((path==='repos/demo/repo/actions/jobs/123/rerun'||path==='repos/demo/repo/actions/runs/444/rerun-failed-jobs') && args.includes('POST')) process.exit(0);",
      "else {console.error('unexpected API '+args.join(' '));process.exit(42)}",
    ].join('\n')+'\n');
    chmodSync(stub, 0o755);
    const script = new URL('./renovate-quarantine-recheck.mjs', import.meta.url);
    const env = {...process.env, PATH: bin+':'+process.env.PATH, FAKE_GH_CALLS:join(root,'calls')};
    const dry = spawnSync(process.execPath, [script.pathname, '--repo=demo/repo'], {env,encoding:'utf8'});
    assert.equal(dry.status,0,dry.stderr || dry.stdout);
    assert.match(dry.stdout, /"type":"dry-run"/);
    assert.equal(readFileSync(env.FAKE_GH_CALLS,'utf8').includes('POST'),false);
    const live = spawnSync(process.execPath, [script.pathname, '--repo=demo/repo','--apply'], {env,encoding:'utf8'});
    assert.equal(live.status,0,live.stderr || live.stdout);
    assert.match(live.stdout, /"type":"rerun"/);
    assert.equal(readFileSync(env.FAKE_GH_CALLS,'utf8').split('POST').length-1,1);
    for (const variant of ['mixed', 'young', 'all-aged']) {
      writeFileSync(env.FAKE_GH_CALLS, '');
      const r = spawnSync(process.execPath, [script.pathname, '--repo=demo/repo','--apply'],
        {env:{...env, FAKE_VARIANT:variant},encoding:'utf8'});
      assert.equal(r.status,0,r.stderr || r.stdout);
      const calls = readFileSync(env.FAKE_GH_CALLS,'utf8');
      if (variant==='all-aged') {
        assert.match(calls, /POST .*runs\/444\/rerun-failed-jobs/);
        assert.equal(calls.split('POST').length-1,1);
      } else {
        assert.equal(calls.includes('POST'),false);
      }
    }
  } finally {
    rmSync(root,{recursive:true,force:true});
  }
});
