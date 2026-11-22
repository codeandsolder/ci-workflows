import assert from 'node:assert/strict';
import test from 'node:test';
import { replacePin, validateCohort, checkBlockers, promotionBlockers, activeCandidate, createDraftPR, verifyBaseline, identifyWorkflowChecks } from './nightly-cohort.mjs';
const from = 'nightly-2026-11-12';
const to = 'nightly-2026-11-19';
const path = '.github/workflows/ci.yml';
const checks = [[path,'tests'],[path,'strict']];
const passed = name => ({ workflowName:'CI',workflowPath:path,name,status:'COMPLETED',conclusion:'SUCCESS' });
test('only the native compiler channel changes; preserve other configuration', () => {
  const original = '# note\n[toolchain]\nchannel = "' + from + '" # pinned\ncomponents = ["clippy"]\n';
  assert.equal(replacePin(original,from,to), original.replace(from,to));
  assert.throws(() => replacePin(original, to, from));
  assert.throws(() => replacePin(original+'[other]\nchannel="'+from+'"\n',from,to));
});
test('all required jobs must have successful results, not skips or absent checks', () => {
  assert.deepEqual(checkBlockers([passed('tests'),passed('strict')],checks),[]);
  assert.equal(checkBlockers([passed('tests')],checks).length,1);
  for (const conclusion of ['SKIPPED','CANCELLED','FAILURE','NEUTRAL','TIMED_OUT']) {
    assert(checkBlockers([passed('tests'),{...passed('strict'),conclusion}],checks).length);
  }
  assert(checkBlockers([passed('tests'),{...passed('strict'),status:'IN_PROGRESS'}],checks).length);
  assert(checkBlockers([{...passed('tests'),workflowPath:'.github/workflows/unrelated.yml'},passed('strict')],checks).length);
});
test('additional failed checks block; intentional optional skipped checks do not', () => {
  const good = [passed('tests'),passed('strict')];
  assert.deepEqual(checkBlockers([...good,{...passed('release'),conclusion:'SKIPPED'}],checks),[]);
  assert(checkBlockers([...good,{...passed('other tests'),conclusion:'FAILURE'}],checks).length);
  assert(checkBlockers([...good,{context:'legacy status',state:'PENDING'}],checks).length);
});
test('one failing cohort member holds central publication', () => {
  assert.deepEqual(promotionBlockers([{name:'a',blockers:[]},{name:'b',blockers:['tests pending']}]),['b: tests pending']);
});
test('enrollment requires explicit checks and coordinator last', () => {
  const a={name:'codeandsolder/example',requiredChecks:checks};
  const c={name:'codeandsolder/ci-workflows',requiredChecks:checks};
  assert.deepEqual(validateCohort({repositories:[a,c]}),[a,c]);
  for (const repositories of [[c,a],[a,a,c],[{...a,requiredChecks:[]},c],[{...a,requiredChecks:[['CI','tests']]},c]]) {
    assert.throws(()=>validateCohort({repositories}));
  }
});

test('daily tick resumes a single cohort candidate and rejects competing or malformed candidates', () => {
  assert.equal(activeCandidate(['feature/a']), null);
  assert.equal(activeCandidate(['automation/fleet-nightly-2026-11-19','automation/fleet-nightly-2026-11-19']), to);
  assert.throws(() => activeCandidate(['automation/fleet-nightly-2026-11-19','automation/fleet-nightly-2026-11-20']));
  assert.throws(() => activeCandidate(['automation/fleet-nightly-invalid']));
});

test('draft creation uses REST for installation-token compatibility and verifies identity', () => {
  const current = {repo:'codeandsolder/public-example',base:'master'};
  const expected = 'automation/fleet-nightly-2026-11-19';
  const pr = {number:42,html_url:'https://github.com/codeandsolder/public-example/pull/42',draft:true,
    head:{ref:expected},base:{ref:'master'}};
  const calls = [];
  const request = (...args) => {calls.push(args); return pr;};
  assert.equal(createDraftPR(request,current,to),pr);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'repos/codeandsolder/public-example/pulls');
  assert.equal(calls[0][1],'POST');
  assert.equal(calls[0][2].head,expected);
  assert.equal(calls[0][2].base,'master');
  assert.equal(calls[0][2].draft,true);
  assert.match(calls[0][2].body,/fleet-nightly-promotion:nightly-2026-11-19/);
  assert.throws(()=>createDraftPR(()=>({...pr,draft:false}),current,to));
  assert.throws(()=>createDraftPR(()=>({...pr,head:{ref:'wrong'}}),current,to));
});
test('idle scheduler detects all out-of-cohort compiler changes rather than silently accepting drift', () => {
  const state = (repo,channel) => ({repo,file:{channel}});
  assert.doesNotThrow(()=>verifyBaseline([state('a',to),state('b',to)],to));
  assert.throws(()=>verifyBaseline([state('a',from),state('b','stable')],to),/a: nightly-2026-11-12[\s\S]*b: stable/);
});

test('required checks are matched to actual PR workflow files and exact candidate head, never display labels', () => {
  const repo = 'codeandsolder/example';
  const pr = {headRefName:'automation/fleet-nightly-2026-11-19',headRefOid:'candidate',number:42};
  const run = {id:123,path,event:'pull_request',head_sha:pr.headRefOid,head_branch:pr.headRefName,
    repository:{full_name:repo},head_repository:{full_name:repo},pull_requests:[{number:42}]};
  const check = {name:'tests',status:'COMPLETED',conclusion:'SUCCESS',workflowName:'.github/workflows/renamed.yml',
    detailsUrl:'https://github.com/'+repo+'/actions/runs/123/job/234'};
  const identify = (runs, source=check) => identifyWorkflowChecks([source],runs,repo,pr);
  assert.deepEqual(checkBlockers(identify([run]),[[path,'tests']]),[]);
  for (const other of [{...run,event:'push'},{...run,head_sha:'old'},{...run,head_branch:'other'},
    {...run,path:'.github/workflows/wrong.yml'},{...run,pull_requests:[{number:99}]},
    {...run,head_repository:{full_name:'someone/fork'}}]) {
    assert(checkBlockers(identify([other]),[[path,'tests']]).length);
  }
  assert(checkBlockers(identify([run],{...check,detailsUrl:'https://github.com/elsewhere/repo/actions/runs/123/job/234'}),[[path,'tests']]).length);
  assert(checkBlockers(identify([run],{...check,detailsUrl:'https://example.com/'}),[[path,'tests']]).length);
  // The REST list endpoint sometimes omits pull_requests for a same-repository run.
  assert.deepEqual(checkBlockers(identify([{...run,pull_requests:[]}]),[[path,'tests']]),[]);
});
