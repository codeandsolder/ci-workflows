#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
cd "$root"
git init -q -b main
git config user.name test
git config user.email test@example.invalid
mkdir -p .github/workflows
echo reviewed > .github/workflows/build.yml
echo source > source.rs
echo initial > output.bin
git add .
git commit -qm base
base=$(git rev-parse HEAD)
git commit --allow-empty -qm candidate
source=$(git rev-parse HEAD)
generate() { GITHUB_OUTPUT="$root/result" node "$here/generated.mjs" commit "$source" "$base" "$1" "$root/candidate.bundle"; }
reject() { if "$@" >"$root/error" 2>&1; then echo "Unexpected success: $*" >&2; exit 1; fi; }
echo regenerated > output.bin
echo forbidden > source.rs
reject generate output.bin
git restore source.rs
git add output.bin
echo forbidden > source.rs
git add source.rs
reject generate output.bin
git restore --staged --worktree source.rs
reject generate .github/workflows/build.yml
reject generate .
reject generate missing.bin
rm output.bin
ln -s source.rs output.bin
reject generate output.bin
git restore --staged --worktree output.bin
echo regenerated > output.bin
generate output.bin
head=$(git rev-parse HEAD)
node "$here/generated.mjs" verify "$source" "$head" output.bin
git bundle verify "$root/candidate.bundle"
git commit -qm counterfeit --allow-empty
reject node "$here/generated.mjs" verify "$source" "$(git rev-parse HEAD)" output.bin
git checkout -q --detach "$source"
echo unauthorized > source.rs
git commit -qam unauthorized
reject node "$here/generated.mjs" verify "$source" "$(git rev-parse HEAD)" output.bin
echo "Generated artifact scope, file types and exact parent verified"
