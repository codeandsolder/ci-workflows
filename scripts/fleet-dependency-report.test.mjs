import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRuns, logReports, normalizeReport, summarizeReports } from './fleet-dependency-report.mjs';

const finding = {kind:'ModernAlternative',current:'old',recommended:'new',impact:'High'};
const good = {directory:'.',anoint:{failed:false,packages:2,version:'0.4.1',policyTriggered:false,findings:[finding]}};
const source = {type:'log',runId:1};

test('private logs recover full report boundaries and preserve empty findings',()=>{
  const root = '/srv/runner/_temp/rust-dependency-quality/workspace-0/results.json';
  const lines = [root,...JSON.stringify(good,null,2).split('\n'), '/srv/runner/_temp/fuzz/results.json',...JSON.stringify({...good,directory:'fuzz',anoint:{...good.anoint,findings:[]}},null,2).split('\n')];
  const log = lines.map(l=>'strict / rust\tUNKNOWN STEP\t2026-11-28T07:01:00Z '+l).join('\n');
  const reports = logReports(log);
  assert.equal(reports.length,2);
  const summary = summarizeReports(reports.map(r=>normalizeReport(r,source)));
  assert.equal(summary.packages,4);
  assert.equal(summary.raw,1);
  assert.equal(summary.unique,1);
  assert.equal(summary.high,1);
  assert(summary.complete);
});

test('missing, corrupt and unavailable scanners never count as zero',()=>{
  assert.equal(normalizeReport({directory:'.',audit:{}},source),null);
  const unavailable = normalizeReport({directory:'.',anoint:{failed:true,packages:0,findings:[]}},source);
  const summary = summarizeReports([unavailable]);
  assert.equal(summary.raw,null);
  assert.equal(summary.unique,null);
  assert.equal(summary.complete,false);
  assert.deepEqual(logReports('job\tstep\t2026-11-28T07:01:00Z /tmp/results.json\njob\tstep\t2026-11-28T07:01:01Z {\njob\tstep\t2026-11-28T07:01:02Z unrelated'),[]);
});

test('deduplicate workspace reports and recommendation tuples; keep advisory overlaps',()=>{
  const first = normalizeReport(good,source);
  const second = normalizeReport({...good,directory:'fuzz',anoint:{...good.anoint,findings:[finding,{kind:'AdvisoryOverlap',current:'a+b',recommended:'one',impact:'Medium'}]}},source);
  const result = summarizeReports([first,first,second]);
  assert.equal(result.packages,4);
  assert.equal(result.raw,3);
  assert.equal(result.unique,2);
  assert.equal(result.advisoryOverlaps.length,1);
});

test('select default branches and group runs by exact commit, not workflow name or date alone',()=>{
  const run = (id,head_branch,head_sha,created_at,name='CI') => ({id,head_branch,head_sha,created_at,name,status:'completed'});
  const runs=[run(1,'main','a','2026-11-28T01:00:00Z'),run(2,'main','b','2026-11-28T02:00:00Z'),run(3,'pr','c','2026-11-28T03:00:00Z'),run(4,'main','b','2026-11-28T02:01:00Z','Strict Rust'),run(5,'main','d','2026-11-28T04:00:00Z','Duplicate-code regression')];
  const groups=groupRuns(runs,[],'main');
  assert.deepEqual(groups.map(g=>g.map(r=>r.id)),[[4,2],[1]]);
});
