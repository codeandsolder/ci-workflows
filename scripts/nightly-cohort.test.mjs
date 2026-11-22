import assert from 'node:assert/strict';
import test from 'node:test';
import { replacePin, validateCohort, checkBlockers, promotionBlockers, activeCandidate } from './nightly-cohort.mjs';
const from = 'nightly-2026-11-12';
const to = 'nightly-2026-11-19';
const checks = [['CI','tests'],['CI','strict']];
const passed = name => ({ workflowName:'CI',name,status:'COMPLETED',conclusion:'SUCCESS' });
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
  assert(checkBlockers([{...passed('tests'),workflowName:'Unrelated'},passed('strict')],checks).length);
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
  for (const repositories of [[c,a],[a,a,c],[{...a,requiredChecks:[]},c]]) {
    assert.throws(()=>validateCohort({repositories}));
  }
});

test('daily tick resumes a single cohort candidate and rejects competing or malformed candidates', () => {
  assert.equal(activeCandidate(['feature/a']), null);
  assert.equal(activeCandidate(['automation/fleet-nightly-2026-11-19','automation/fleet-nightly-2026-11-19']), to);
  assert.throws(() => activeCandidate(['automation/fleet-nightly-2026-11-19','automation/fleet-nightly-2026-11-20']));
  assert.throws(() => activeCandidate(['automation/fleet-nightly-invalid']));
});
