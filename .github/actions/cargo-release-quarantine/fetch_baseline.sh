#!/usr/bin/env bash
# Fetch the immutable baseline commit without materializing submodule history.
set -euo pipefail

base_ref="${1:?baseline commit/ref required}"
if git cat-file -e "${base_ref}^{commit}" 2>/dev/null; then
  echo "Cargo quarantine baseline is present locally; no network fetch needed"
  exit 0
fi

# We inspect only tracked Cargo.lock blobs. A caller may configure recursive
# fetch, and its history can reference unreachable gitlinks in unrelated
# submodules. Git can fail such a recursive fetch *after* fetching the baseline.
# Explicitly overriding fetch.recurseSubmodules avoids that unrelated failure.
git fetch --no-recurse-submodules --no-tags origin "${base_ref}"
