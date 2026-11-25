# Clone-regression classifier acceptance corpus

`clone-policy.json` is a **frozen decision corpus**, recorded once from the
retired independent Python classifier before removing it. It contains 23
case configurations, filesystem/source fixtures and **complete expected
classification reports** (16 accepted and 7 deliberately rejected policies).

The acceptance cases cover nested Rust block comments, normal/raw strings,
false test attributes inside literals, `#[cfg(test)]` modules, direct
`#[test]`, async test attributes, mixed production/test clones, test-file
naming conventions, missing and escaping source files, exact 100/140-token
boundaries, custom valid thresholds, case-insensitive fingerprint
acceptances, configuration attempts to override central scanner settings,
scope-restricted scans, and preservation of unknown scanner fields.
Rejected cases check malformed, non-hex, duplicated or inadequately explained
exceptions and invalid threshold combinations.

`node policy-wasm/clones.test.mjs policy-wasm/module.json` creates isolated
source trees and invokes the **actual bundled Rust/WASI classifier** for each
case. The resulting JSON is compared recursively against the literal
snapshot. Supplemental native Node tests reject symlink escapes, enforce the
mandatory gate's immutable scanner thresholds/exclusions and check complete
consumer report structure. The same test runs on the freshly compiled WASI
module, and on the bundled module across Linux, macOS and Windows.

The separate `.github/scripts/test-clone-regression.sh` exercises the **real
pinned doppelscan binary** against Git history, including renamed clones,
test-only duplicates, cross-boundary production clones, reviewed accepts,
synthetic merge parents, shallow checkouts and corrupt archive rejection.

Do not regenerate the corpus from the Rust implementation under test.
Review source changes, intended outcomes and scanner behavior before editing
expected values. The temporary Python script used for the one-time legacy
capture lives outside this repository.
