#!/usr/bin/env node
// Explicit, evidence-backed repository enrollment. No blanket rule changes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { isMaintainedRepo } from './fleet-scope.mjs';

const run = promisify(execFile);
const rulesetName = 'Native Renovate CI';
const gateSuffix = ' / Verify expected job results';

async function api(endpoint, method = 'GET', payload) {
  const args = ['api', '-X', method, endpoint];
  // gh -f interprets JSON arrays as strings; stream the JSON body directly.
  if (payload !== undefined) {
    return await new Promise((resolve, reject) => {
      const child = execFile('gh', [...args, '--input', '-'], {
        encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
      }, (error, stdout) => {
        if (error) reject(error);
        else {
          try { resolve(JSON.parse(stdout)); }
          catch (parseError) { reject(parseError); }
        }
      });
      child.stdin.on('error', reject);
      child.stdin.end(JSON.stringify(payload));
    });
  }
  const {stdout} = await run('gh', args, {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export function verifiedChecks(contexts, checkRuns, sha) {
  if (!Array.isArray(contexts) || !contexts.length ||
      new Set(contexts).size !== contexts.length ||
      contexts.some(context => typeof context !== 'string' || !context.endsWith(gateSuffix))) {
    throw new Error('Supply every reviewed, uniquely named terminal merge-gate context');
  }
  return contexts.map(context => {
    const matches = checkRuns.filter(check => check.name === context);
    if (matches.length !== 1) throw new Error('Missing or ambiguous gate: ' + context);
    const [check] = matches;
    if (check.head_sha !== sha || check.app?.slug !== 'github-actions' ||
        !Number.isSafeInteger(check.app.id) || check.app.id <= 0 ||
        check.status !== 'completed' || check.conclusion !== 'success') {
      throw new Error('Gate has no successful current GitHub Actions result: ' + context);
    }
    return {context, integration_id: check.app.id};
  });
}

export function desiredRuleset(branch, checks) {
  return {
    name: rulesetName,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {ref_name: {include: ['refs/heads/' + branch], exclude: []}},
    rules: [{
      type: 'required_status_checks',
      parameters: {
        required_status_checks: checks,
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
      },
    }],
  };
}

export function verifiesRequiredRule(rules, checks, id) {
  return rules.some(rule => {
    if (rule.type !== 'required_status_checks' || rule.ruleset_id !== id ||
        rule.parameters?.strict_required_status_checks_policy !== true) return false;
    return checks.every(check => rule.parameters.required_status_checks?.some(
      candidate => candidate.context === check.context &&
        candidate.integration_id === check.integration_id));
  });
}

function existingMatches(existing, desired) {
  if (existing.enforcement !== 'active' || existing.target !== 'branch' ||
      !Array.isArray(existing.bypass_actors) || existing.bypass_actors.length !== 0 ||
      existing.conditions?.ref_name?.include?.length !== 1 ||
      existing.conditions.ref_name.include[0] !== desired.conditions.ref_name.include[0] ||
      existing.conditions.ref_name.exclude?.length !== 0 ||
      existing.rules?.length !== 1) return false;
  const checks = desired.rules[0].parameters.required_status_checks;
  const [rule] = existing.rules;
  return rule.parameters?.required_status_checks?.length === checks.length &&
    rule.parameters?.do_not_enforce_on_create !== true &&
    verifiesRequiredRule([{...rule, ruleset_id: existing.id}], checks, existing.id);
}

async function checkRuns(root, sha, request) {
  const results = [];
  for (let page = 1; ; page++) {
    const response = await request(root + '/commits/' + sha +
      '/check-runs?filter=latest&per_page=100&page=' + page);
    if (!Array.isArray(response.check_runs)) throw new Error('Invalid check-run response');
    results.push(...response.check_runs);
    if (response.check_runs.length < 100) return results;
  }
}

export async function enroll(repo, proofPr, contexts, apply = false, request = api) {
  if (!/^codeandsolder\/[A-Za-z0-9_.-]+$/.test(repo) ||
      !Number.isSafeInteger(proofPr) || proofPr <= 0) {
    throw new Error('Expected codeandsolder/REPO and a merged gate validation PR number');
  }
  const root = 'repos/' + repo;
  const metadata = await request(root);
  if (!isMaintainedRepo(metadata) || metadata.disabled || !metadata.default_branch) {
    throw new Error('Repository is outside active fleet scope');
  }
  const branch = metadata.default_branch;
  // The rules API must actually be available (private free-plan repos fail here).
  const activeRules = root + '/rules/branches/' + encodeURIComponent(branch);
  await request(activeRules);
  const proof = await request(root + '/pulls/' + proofPr);
  if (proof.merged !== true || proof.base?.ref !== branch ||
      proof.base?.repo?.full_name !== metadata.full_name || !proof.head?.sha) {
    throw new Error('Proof must be a merged PR into the current default branch');
  }
  const refEndpoint = root + '/git/ref/heads/' + encodeURIComponent(branch);
  const current = (await request(refEndpoint)).object?.sha;
  if (!current) throw new Error('No current default-branch commit');
  const prChecks = verifiedChecks(contexts, await checkRuns(root, proof.head.sha, request), proof.head.sha);
  const mainChecks = verifiedChecks(contexts, await checkRuns(root, current, request), current);
  if (JSON.stringify(prChecks) !== JSON.stringify(mainChecks)) throw new Error('Gate integration changed');
  const desired = desiredRuleset(branch, mainChecks);
  const existingList = [];
  for (let page = 1; ; page++) {
    const batch = await request(root + '/rulesets?includes_parents=false&per_page=100&page=' + page);
    if (!Array.isArray(batch)) throw new Error('Invalid ruleset list');
    existingList.push(...batch);
    if (batch.length < 100) break;
  }
  const matching = existingList.filter(rule => rule.name === rulesetName);
  if (matching.length > 1) throw new Error('Ambiguous native automerge ruleset');
  let existing;
  if (matching.length) {
    existing = await request(root + '/rulesets/' + matching[0].id);
    if (!existingMatches(existing, desired)) throw new Error('Existing ruleset differs; reconcile explicitly');
  }
  if (!apply) return {repo, branch, current, desired, existing: existing?.id ?? null, apply: false};
  if ((await request(refEndpoint)).object?.sha !== current) throw new Error('Default branch advanced; retry');
  if (!existing) existing = await request(root + '/rulesets', 'POST', desired);
  if (!existingMatches(await request(root + '/rulesets/' + existing.id), desired)) {
    throw new Error('Ruleset contents not confirmed; native auto-merge unchanged');
  }
  // Do not enable native auto-merge until the active rules API confirms enforcement.
  if (!verifiesRequiredRule(await request(activeRules), mainChecks, existing.id)) {
    throw new Error('Required CI rules not confirmed active; native auto-merge unchanged');
  }
  await request(root, 'PATCH', {allow_auto_merge: true});
  if ((await request(root)).allow_auto_merge !== true) throw new Error('GitHub auto-merge not enabled');
  return {repo, branch, current, ruleset: existing.id, contexts, allow_auto_merge: true,
    next: 'Extend github>codeandsolder/ci-workflows:renovate-native-automerge after the existing shared preset'};
}

async function main() {
  const [mode, repo, number, ...contexts] = process.argv.slice(2);
  if (!['plan', 'apply'].includes(mode)) {
    throw new Error('Usage: native-renovate-automerge.mjs plan|apply codeandsolder/REPO MERGED_PR "CI merge gate / Verify expected job results" [...]');
  }
  console.log(JSON.stringify(await enroll(repo, Number(number), contexts, mode === 'apply'), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
