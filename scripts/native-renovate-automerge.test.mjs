import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { desiredRuleset, enroll, verifiedChecks, verifiesRequiredRule } from './native-renovate-automerge.mjs';

const repo = 'codeandsolder/test';
const root = 'repos/' + repo;
const context = 'CI merge gate / Verify expected job results';
const mainSha = 'main-sha';
const prSha = 'pr-sha';
const result = sha => ({
  name: context, head_sha: sha, app: {slug: 'github-actions', id: 15368},
  status: 'completed', conclusion: 'success',
});
const required = [{context, integration_id: 15368}];

function fixture({failRules = false, failActivation = false, prConclusion = 'success', existing = null} = {}) {
  const calls = [];
  let active = existing;
  let enabled = false;
  async function request(endpoint, method = 'GET', payload) {
    calls.push({endpoint, method, payload});
    if (endpoint === root && method === 'GET') return {
      full_name: repo, default_branch: 'main', archived: false, disabled: false, allow_auto_merge: enabled,
    };
    if (endpoint === root && method === 'PATCH') {
      assert.deepEqual(payload, {allow_auto_merge: true});
      enabled = true;
      return {allow_auto_merge: true};
    }
    if (endpoint === root + '/rules/branches/main') {
      if (failRules) throw new Error('403 plan does not support rulesets');
      return active && !failActivation ? active.rules.map(rule => ({...rule, ruleset_id: active.id})) : [];
    }
    if (endpoint === root + '/pulls/1') return {
      merged: true, base: {ref: 'main', repo: {full_name: repo}}, head: {sha: prSha},
    };
    if (endpoint === root + '/git/ref/heads/main') return {object: {sha: mainSha}};
    if (endpoint.startsWith(root + '/commits/' + prSha + '/check-runs?')) return {
      check_runs: [{...result(prSha), conclusion: prConclusion}],
    };
    if (endpoint.startsWith(root + '/commits/' + mainSha + '/check-runs?')) return {check_runs: [result(mainSha)]};
    if (endpoint.startsWith(root + '/rulesets?')) return active ? [{name: active.name, id: active.id}] : [];
    if (endpoint === root + '/rulesets' && method === 'POST') {
      active = {...payload, id: 10};
      return active;
    }
    if (endpoint === root + '/rulesets/10') return active;
    throw new Error('Unexpected request: ' + endpoint);
  }
  return {calls, request};
}

test('native preset changes only merge transport, not eligibility or CI policy', () => {
  const preset = JSON.parse(readFileSync(new URL('../renovate-native-automerge.json', import.meta.url), 'utf8'));
  const {$schema, description, ...settings} = preset;
  assert.deepEqual(settings, {platformAutomerge: true, automergeType: 'pr', ignoreTests: false});
});
test('checks must be current, successful, unique and attributed to Actions', () => {
  assert.deepEqual(verifiedChecks([context], [result(prSha)], prSha), required);
  for (const bad of [
    [], [result(mainSha)], [result(prSha), result(prSha)],
    [{...result(prSha), conclusion: 'skipped'}],
    [{...result(prSha), conclusion: 'failure'}],
    [{...result(prSha), status: 'queued'}],
    [{...result(prSha), app: {slug: 'another-app', id: 15368}}],
  ]) assert.throws(() => verifiedChecks([context], bad, prSha));
  assert.throws(() => verifiedChecks([], [], prSha));
  assert.throws(() => verifiedChecks([context, context], [result(prSha)], prSha));
  assert.throws(() => verifiedChecks(['arbitrary check'], [result(prSha)], prSha));
});
test('plan does not mutate settings', async () => {
  const f = fixture();
  const plan = await enroll(repo, 1, [context], false, f.request);
  assert.deepEqual(plan.desired, desiredRuleset('main', required));
  assert(f.calls.every(call => call.method === 'GET'));
});
test('apply creates required, up-to-date, Actions-attributed rules before native automerge', async () => {
  const f = fixture();
  const response = await enroll(repo, 1, [context], true, f.request);
  assert.equal(response.allow_auto_merge, true);
  const changes = f.calls.filter(call => call.method !== 'GET');
  assert.deepEqual(changes.map(call => call.method), ['POST', 'PATCH']);
  const ruleset = changes[0].payload;
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.equal(ruleset.enforcement, 'active');
  assert.equal(ruleset.rules[0].parameters.strict_required_status_checks_policy, true);
  assert.deepEqual(ruleset.rules[0].parameters.required_status_checks, required);
});
test('existing verified ruleset is reused without modification', async () => {
  const f = fixture({existing: {...desiredRuleset('main', required), id: 10}});
  await enroll(repo, 1, [context], true, f.request);
  assert.deepEqual(f.calls.filter(call => call.method !== 'GET').map(call => call.method), ['PATCH']);
});
test('fail closed on unavailable rules, unsuccessful proof or missing enforcement', async () => {
  for (const options of [{failRules: true}, {prConclusion: 'skipped'}, {failActivation: true},
    {existing: {...desiredRuleset('main', required), id: 10, bypass_actors: [{actor_id: 1}]}}]) {
    const f = fixture(options);
    await assert.rejects(enroll(repo, 1, [context], true, f.request));
    assert(!f.calls.some(call => call.method === 'PATCH'));
  }
});
test('active rule verification checks both integration and strictness', () => {
  const [rule] = desiredRuleset('main', required).rules;
  assert(verifiesRequiredRule([{...rule, ruleset_id: 10}], required, 10));
  assert(!verifiesRequiredRule([{...rule, ruleset_id: 11}], required, 10));
  assert(!verifiesRequiredRule([{...rule, ruleset_id: 10, parameters: {
    ...rule.parameters, strict_required_status_checks_policy: false,
  }}], required, 10));
  assert(!verifiesRequiredRule([{...rule, ruleset_id: 10, parameters: {
    ...rule.parameters, required_status_checks: [{context, integration_id: 1}],
  }}], required, 10));
});
