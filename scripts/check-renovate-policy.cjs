#!/usr/bin/env node
const assert=require('node:assert/strict');
const fs=require('node:fs');
const fleet=JSON.parse(fs.readFileSync('renovate-fleet.json','utf8'));
const trust=JSON.parse(fs.readFileSync('renovate-ci-trust-root.json','utf8'));
const self=JSON.parse(fs.readFileSync('renovate.json','utf8'));
const firstParty='github>codeandsolder/ci-workflows:renovate-ci-trust-root';
const main='github>codeandsolder/ci-workflows:renovate-fleet';
assert(fleet.extends.includes(firstParty));
assert.deepEqual(self.extends,[main]);
assert.equal(fleet.platformAutomerge,false);
assert.equal(fleet.ignoreTests,false);
assert.equal(trust.platformAutomerge,false);
assert.equal(trust.ignoreTests,false);
assert.equal(fleet.minimumReleaseAge,'3 days');
assert.equal(fleet.minimumReleaseAgeBehaviour,'timestamp-required');
assert.equal(fleet.internalChecksFilter,'strict');
const firstRule=trust.packageRules.find(r=>(r.matchPackageNames||[]).join('').includes('ci-workflows'));
assert(firstRule);
assert.equal(firstRule.automerge,true);
assert.equal(firstRule.minimumReleaseAge,null);
assert.deepEqual(firstRule.matchUpdateTypes,['digest','pinDigest']);
assert.deepEqual(firstRule.matchManagers,['github-actions']);
// Renovate #45236: branch-level stability status has no usable timestamp for these update classes.
// The global 72h timestamp-required policy remains intact for normal releases.
const timestampOptional=fleet.packageRules.find(r=>r.minimumReleaseAgeBehaviour==='timestamp-optional');
assert(timestampOptional);
assert.deepEqual(timestampOptional.matchUpdateTypes,['pin','pinDigest','digest','lockFileMaintenance','lockfileUpdate']);
assert.equal(Object.hasOwn(timestampOptional,'minimumReleaseAge'),false);
assert.equal(Object.hasOwn(timestampOptional,'automerge'),false);
const runners=fleet.packageRules.find(r=>r.matchDepTypes?.includes('github-runner'));
assert(runners);
assert.deepEqual(runners.matchDepTypes,['github-runner']);
assert.equal(runners.minimumReleaseAge,null);
assert.equal(Object.hasOwn(runners,'automerge'),false);
const stable=fleet.packageRules.find(r=>r.matchCurrentVersion==='!/^0\\./');
assert.equal(stable.automerge,true);
assert(stable.matchUpdateTypes.includes('patch'));
const zeroPatch=fleet.packageRules.find(r=>r.matchCurrentVersion==='/^0\\./');
assert.deepEqual(zeroPatch.matchUpdateTypes,['patch']);
assert.equal(zeroPatch.automerge,true);
for (const type of ['major','replacement']) {
 const rule=fleet.packageRules.find(r=>r.matchUpdateTypes?.includes(type));
 assert.equal(rule.automerge,false, type);
}
const actions=fleet.packageRules.find(r=>r.matchManagers?.includes('github-actions'));
assert.deepEqual(actions.matchUpdateTypes,['digest','pinDigest']);
assert.equal(actions.automerge,true);
assert.equal(fleet.lockFileMaintenance.automerge,true);
console.log('Shared fleet Renovate configuration and trust-root precedence invariants: PASS');
