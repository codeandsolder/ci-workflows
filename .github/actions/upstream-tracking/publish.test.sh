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
git checkout -q --detach "$ancestor"
git commit -qm upstream --allow-empty
upstream=$(git rev-parse HEAD)
git commit -qm rebased --allow-empty
head=$(git rev-parse HEAD)
git bundle create -q ../candidate.bundle HEAD ^"$ancestor"
git checkout -q --detach "$base"
publish() { node "$here/publish.mjs" main "$base" "$1" "$2" ../candidate.bundle; }
remote_ref() { git --git-dir=../origin.git rev-parse "$1"; }
archive="refs/tags/fork-history/$base/$upstream"
# Wrong exact candidate and missing upstream ancestry must both fail.
if publish "$ancestor" "$upstream"; then exit 1; fi
if publish "$head" "$base"; then exit 1; fi
test "$(remote_ref refs/heads/main)" = "$base"
# A concurrent rollback must fail atomically, without creating an archive.
git --git-dir=../origin.git update-ref refs/heads/main "$ancestor"
if publish "$head" "$upstream"; then exit 1; fi
test "$(remote_ref refs/heads/main)" = "$ancestor"
if git --git-dir=../origin.git show-ref --verify --quiet "$archive"; then exit 1; fi
# Refuse a conflicting archive rather than rewriting it.
git --git-dir=../origin.git update-ref refs/heads/main "$base"
git --git-dir=../origin.git update-ref "$archive" "$ancestor"
if publish "$head" "$upstream"; then exit 1; fi
test "$(remote_ref refs/heads/main)" = "$base"
test "$(remote_ref "$archive")" = "$ancestor"
git --git-dir=../origin.git update-ref -d "$archive"
# Successful rebased publication and old-pin reachability.
publish "$head" "$upstream"
test "$(remote_ref refs/heads/main)" = "$head"
test "$(remote_ref "$archive")" = "$base"
git clone -q ../origin.git ../consumer
git -C ../consumer cat-file -e "$base^{commit}"
# Already existing exact archive is safe on a retry.
git --git-dir=../origin.git update-ref refs/heads/main "$base"
publish "$head" "$upstream"
test "$(remote_ref refs/heads/main)" = "$head"
echo 'Exact rebased candidate, upstream ancestry, archived pins and atomic base lease verified'
