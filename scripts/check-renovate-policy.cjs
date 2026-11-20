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
const noAge=fleet.packageRules.at(-2);
assert.deepEqual(noAge.matchPackageNames,['/.*/']);
assert.equal(noAge.minimumReleaseAge,null);
assert.equal(noAge.minimumReleaseAgeBuffer,null);
const externalCrates=fleet.packageRules.at(-1);
assert.deepEqual(externalCrates.matchManagers,['cargo']);
assert.deepEqual(externalCrates.matchDatasources,['crate']);
assert.equal(externalCrates.minimumReleaseAge,'3 days');
assert.equal(externalCrates.minimumReleaseAgeBehaviour,'timestamp-required');
// Crate names are not repository owner identifiers. Do not waive age for
// a crate using a self-declared repository URL. First-party Git dependencies
// and Actions have different datasources and never match this registry rule.
assert.equal(Object.hasOwn(externalCrates,'matchSourceUrls'),false);
assert.equal(Object.hasOwn(externalCrates,'matchPackageNames'),false);
for (const rule of [...fleet.packageRules.slice(0,-2),...trust.packageRules]) {
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
// A pinned nightly in rust-toolchain.toml is extracted by the built-in
// rust-toolchain manager; the regex manager must extract the same logical
// rust-version/rust dependency from every reusable-workflow toolchain input.
// Otherwise Renovate updates the manifest alone and the caller's CI fails.
const nightlyManager=fleet.customManagers.find(m=>m.depNameTemplate==='rust'
 && m.datasourceTemplate==='rust-version');
assert(nightlyManager,'missing shared Rust nightly workflow extractor');
assert.equal(nightlyManager.customType,'regex');
assert.equal(nightlyManager.versioningTemplate,'rust-release-channel');
assert(nightlyManager.managerFilePatterns.some(p=>new RegExp(p.slice(1,-1)).test('.github/workflows/ci.yml')));
const nightlyPattern=new RegExp(nightlyManager.matchStrings[0],'g');
const inputFixture=[
  'jobs:',
  '  rust:',
  '    with:',
  '      rust-toolchain: "nightly-2026-11-15"',
  '      rust-components: "rustfmt clippy"',
  '  wasm:',
  '    with:',
  "      rust-toolchain: 'nightly-2026-11-15' # comment",
  '      rust-toolchain-unrelated: "nightly-2026-11-15"',
  '      rust-toolchain: nightly-2026-11-15 # unquoted',
].join('\r\n');
const nightlies=[...inputFixture.matchAll(nightlyPattern)];
assert.equal(nightlies.length,3,'extract every workflow compiler pin, including CRLF and YAML quoting variants');
assert.deepEqual(nightlies.map(m=>m.groups.currentValue),Array(3).fill('nightly-2026-11-15'));
const updatedFixture=nightlies.reduceRight(
 (updated,m)=>updated.slice(0,m.index)+m[0].replace(m.groups.currentValue,'nightly-2026-11-16')
     +updated.slice(m.index+m[0].length), inputFixture);
assert.equal((updatedFixture.match(/nightly-2026-11-16/g)||[]).length,3);
assert(updatedFixture.includes('rust-toolchain-unrelated: "nightly-2026-11-15"'));
// A job that needs the same nightly for setup-sccache, rustup and cargo
// declares one env value. The shared extractor must track that source pin.
assert.equal(nightlyManager.matchStrings.length,2);
const envPattern=new RegExp(nightlyManager.matchStrings[1],'g');
const envFixture=[
  'env:',
  '  RUST_NIGHTLY_TOOLCHAIN: nightly-2026-11-15',
  '  RUST_NIGHTLY_TOOLCHAIN_OTHER: nightly-2026-11-15',
  "  RUST_NIGHTLY_TOOLCHAIN: 'nightly-2026-11-16' # review-only",
  '  RUST_NIGHTLY_TOOLCHAIN: "nightly-2026-11-17"',
  '  RUST_NIGHTLY_TOOLCHAIN: stable',
].join('\r\n');
const envPins=[...envFixture.matchAll(envPattern)];
assert.deepEqual(envPins.map(m=>m.groups.currentValue),[
  'nightly-2026-11-15', 'nightly-2026-11-16', 'nightly-2026-11-17',
]);
assert(envPins.every(m=>!m[0].includes('TOOLCHAIN_OTHER')));
const envUpdated=envPins.reduceRight(
 (updated,m)=>updated.slice(0,m.index)+m[0].replace(m.groups.currentValue,'nightly-2026-11-18')
     +updated.slice(m.index+m[0].length), envFixture);
assert.equal((envUpdated.match(/RUST_NIGHTLY_TOOLCHAIN: (?:"|'|)nightly-2026-11-18/g)||[]).length,3);
assert(envUpdated.includes('RUST_NIGHTLY_TOOLCHAIN_OTHER: nightly-2026-11-15'));
const nightlyGroup=fleet.packageRules.find(r=>r.groupSlug==='pinned-rust-nightly');
assert(nightlyGroup,'missing nightly grouping policy');
assert.deepEqual(nightlyGroup.matchDepNames,['rust']);
assert.deepEqual(nightlyGroup.matchDatasources,['rust-version']);
assert.deepEqual(nightlyGroup.matchManagers,['rust-toolchain','custom.regex']);
assert.equal(nightlyGroup.matchCurrentVersion,'/^nightly-/');
assert.equal(nightlyGroup.automerge,false);
assert(fleet.packageRules.indexOf(nightlyGroup)>fleet.packageRules.indexOf(toolchain));
assert.equal(fleet.lockFileMaintenance.automerge,true);
console.log('Shared fleet Renovate configuration and trust-root precedence invariants: PASS');
