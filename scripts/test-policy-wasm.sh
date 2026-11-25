#!/usr/bin/env bash
set -euo pipefail

# Pass either the freshly compiled WASI binary or the checked-in module manifest.
module="$1"
for test in \
  policy-wasm/concurrency.test.mjs \
  policy-wasm/sccache.test.mjs \
  policy-wasm/quarantine.test.mjs \
  policy-wasm/cargo-affected.test.mjs \
  policy-wasm/checklist-labels.test.mjs \
  scripts/rust-release-review.test.mjs \
  scripts/runner-availability.test.mjs \
  scripts/renovate-quarantine-recheck.test.mjs \
  policy-wasm/upstream.test.mjs \
  policy-wasm/clones.test.mjs; do
  node "$test" "$module"
done
