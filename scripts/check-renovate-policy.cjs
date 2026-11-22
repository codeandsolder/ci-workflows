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
assert.equal(fleet.minimumReleaseAge,null, 'age scope is determined by dependency source, not consuming repository');
assert.equal(Object.hasOwn(fleet,'minimumReleaseAgeBehaviour'),false);
assert.equal(fleet.internalChecksFilter,'strict');
// Limit CI-producing commits, not just PR creation. Preserve CI-gated,
// up-to-date automerge while avoiding needless rebases of review-only PRs.
assert.equal(fleet.prHourlyLimit,1);
assert.equal(fleet.commitHourlyLimit,1);
assert.equal(fleet.rebaseWhen,'auto');
assert.equal(fleet.prConcurrentLimit,6);
const firstRule=trust.packageRules.find(r=>(r.matchPackageNames||[]).join('').includes('ci-workflows'));
assert(firstRule);
assert.equal(firstRule.automerge,true);
assert.deepEqual(firstRule.matchUpdateTypes,['digest','pinDigest']);
assert.deepEqual(firstRule.matchManagers,['github-actions']);
const noAge=fleet.packageRules.at(-3);
assert.deepEqual(noAge.matchPackageNames,['/.*/']);
assert.equal(noAge.minimumReleaseAge,null);
assert.equal(noAge.minimumReleaseAgeBuffer,null);
const externalCrates=fleet.packageRules.at(-2);
assert.deepEqual(externalCrates.matchManagers,['cargo']);
assert.deepEqual(externalCrates.matchDatasources,['crate']);
assert.equal(externalCrates.minimumReleaseAge,'3 days');
assert.equal(externalCrates.minimumReleaseAgeBehaviour,'timestamp-required');
// Crate names are not repository owner identifiers. Do not waive age for
// a crate using a self-declared repository URL. First-party Git dependencies
// and Actions have different datasources and never match this registry rule.
assert.equal(Object.hasOwn(externalCrates,'matchSourceUrls'),false);
assert.equal(Object.hasOwn(externalCrates,'matchPackageNames'),false);
for (const rule of [...fleet.packageRules.slice(0,-3),...trust.packageRules]) {
 assert.equal(Object.hasOwn(rule,'minimumReleaseAge'),false, 'age policy belongs in final source-based rules');
}
const quarantine=fs.readFileSync('.github/workflows/cargo-release-quarantine.yml','utf8');
assert(!quarantine.includes('github.repository_owner'),'do not exempt all dependencies by caller ownership');
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
const toolchain=fleet.packageRules.find(r=>r.matchManagers?.includes('rust-toolchain'));
assert(toolchain,'missing Rust toolchain review-only rule');
assert.deepEqual(toolchain.matchManagers,['rust-toolchain']);
assert.equal(toolchain.automerge,false);
assert.equal(toolchain.enabled,undefined);
assert(fleet.packageRules.indexOf(toolchain)>fleet.packageRules.indexOf(stable),'toolchain rule must override generic stable minor automerge');
// The native root manifest is the only compiler source. A final, narrowly
// scoped rule overrides the general review-only compiler and age-reset rules.
assert.equal(fleet.customManagers?.length ?? 0,0,'no duplicate workflow pin extractor');
const nightlyGroup=fleet.packageRules.at(-1);
assert.equal(nightlyGroup.groupSlug,'pinned-rust-nightly');
assert.deepEqual(nightlyGroup.matchDepNames,['rust']);
assert.deepEqual(nightlyGroup.matchDatasources,['rust-version']);
assert.deepEqual(nightlyGroup.matchManagers,['rust-toolchain']);
assert.deepEqual(nightlyGroup.matchFileNames,['/^rust-toolchain\\.toml$/']);
const nightly=new RegExp(nightlyGroup.matchCurrentValue.slice(1,-1));
assert.equal(nightlyGroup.allowedVersions,nightlyGroup.matchCurrentValue);
assert(nightly.test('nightly-2026-11-19'));
for (const value of ['stable','nightly','1.100.0','nightly-2026-11-19-x86_64-unknown-linux-gnu']) {
 assert(!nightly.test(value),value);
}
assert.equal(nightlyGroup.automerge,true);
assert.equal(nightlyGroup.automergeType,'pr');
assert.notEqual(nightlyGroup.enabled,false);
assert.deepEqual(nightlyGroup.schedule,['* * * * 1']);
assert.equal(nightlyGroup.timezone,'Etc/UTC');
assert.equal(nightlyGroup.updateNotScheduled,false);
assert.equal(nightlyGroup.minimumReleaseAge,'4 days');
assert.equal(nightlyGroup.minimumReleaseAgeBehaviour,'timestamp-required');
assert.equal(nightlyGroup.ignoreUnstable,false);
assert(fleet.packageRules.indexOf(nightlyGroup)>fleet.packageRules.indexOf(toolchain));
assert(fleet.packageRules.indexOf(nightlyGroup)>fleet.packageRules.indexOf(noAge));
assert.equal(fleet.lockFileMaintenance.automerge,true);
console.log('Shared fleet Renovate configuration and trust-root precedence invariants: PASS');
