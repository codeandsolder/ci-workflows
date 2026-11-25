#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
git init -q -b main "$root/upstream"
git -C "$root/upstream" config user.name test
git -C "$root/upstream" config user.email test@example.invalid
echo base > "$root/upstream/file"
git -C "$root/upstream" add file
git -C "$root/upstream" commit -qm base
git clone -q --bare "$root/upstream" "$root/origin.git"
git clone -q "$root/origin.git" "$root/fork"
git -C "$root/fork" config url."file://$root/upstream".insteadOf https://github.com/example/project.git
echo new > "$root/upstream/new"
git -C "$root/upstream" add new
git -C "$root/upstream" commit -qm tip
tip=$(git -C "$root/upstream" rev-parse HEAD)
cd "$root/fork"
GITHUB_OUTPUT="$root/first" node "$here/observe.mjs" example/project main
test "$(sed -n 's/^status=//p' "$root/first")" = quarantined
git --git-dir="$root/origin.git" show automation/upstream-observations:observations.json | node -e '
  const d = JSON.parse(require("fs").readFileSync(0));
  if (d.observations.length !== 1 || d.observations[0].sha !== process.argv[1]) process.exit(1);
' "$tip"
state=$(git --git-dir="$root/origin.git" rev-parse automation/upstream-observations)
GITHUB_OUTPUT="$root/second" node "$here/observe.mjs" example/project main
test "$(sed -n 's/^status=//p' "$root/second")" = already-run
test "$(git --git-dir="$root/origin.git" rev-parse automation/upstream-observations)" = "$state"
test "$(git --git-dir="$root/origin.git" rev-parse main)" = "$(git rev-parse HEAD)"
echo 'Persistent observation state verified'
