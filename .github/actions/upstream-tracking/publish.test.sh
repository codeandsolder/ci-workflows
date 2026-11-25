#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
cd "$root"
git init -q -b main work
cd work
git config user.name test
git config user.email test@example.invalid
git commit -qm ancestor --allow-empty
ancestor=$(git rev-parse HEAD)
git commit -qm base --allow-empty
base=$(git rev-parse HEAD)
git clone -q --bare . ../origin.git
git remote add origin ../origin.git
git commit -qm candidate --allow-empty
head=$(git rev-parse HEAD)
git bundle create -q ../candidate.bundle HEAD ^"$base"
git checkout -q --detach "$base"
publish() { node "$here/publish.mjs" main "$base" "$1" "$2" ../candidate.bundle; }
remote_head() { git --git-dir=../origin.git rev-parse refs/heads/main; }
# Refuse the wrong candidate even when the base is unchanged.
if publish "$ancestor" merge; then exit 1; fi
test "$(remote_head)" = "$base"
# Successful publication must use exactly the validated object.
publish "$head" merge
test "$(remote_head)" = "$head"
# A concurrent rollback is also an unexpected base, even though it would
# otherwise permit a normal fast-forward push.
git --git-dir=../origin.git update-ref refs/heads/main "$ancestor"
if publish "$head" merge; then exit 1; fi
test "$(remote_head)" = "$ancestor"
# Test non-fast-forward candidate publication and merge ancestry guard.
git --git-dir=../origin.git update-ref refs/heads/main "$base"
git checkout -q --detach "$ancestor"
git commit -qm rebased --allow-empty
head=$(git rev-parse HEAD)
git bundle create -q ../candidate.bundle HEAD ^"$ancestor"
git checkout -q --detach "$base"
if publish "$head" merge; then exit 1; fi
test "$(remote_head)" = "$base"
publish "$head" rebase
test "$(remote_head)" = "$head"
echo 'Publication candidate, ancestry and exact-base lease verified'
