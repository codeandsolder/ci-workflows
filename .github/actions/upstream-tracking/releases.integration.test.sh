#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
git init -q -b main "$root/upstream"
git -C "$root/upstream" config user.name test
git -C "$root/upstream" config user.email test@example.invalid
git -C "$root/upstream" commit -qm base --allow-empty
git -C "$root/upstream" tag -am crate-release crate-v7.3.0
upstream=$(git -C "$root/upstream" rev-parse HEAD)
git clone -q "$root/upstream" "$root/fork"
git -C "$root/fork" config user.name test
git -C "$root/fork" config user.email test@example.invalid
git -C "$root/fork" commit -qm fork --allow-empty
head=$(git -C "$root/fork" rev-parse HEAD)
git clone -q --bare "$root/fork" "$root/origin.git"
git -C "$root/fork" remote set-url origin "$root/origin.git"
git -C "$root/fork" config url."file://$root/upstream".insteadOf https://github.com/example/project.git
mkdir "$root/bin"
cat > "$root/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
directory=$(dirname "$(dirname "$0")")
case "$1" in
  api)
    case "${*: -1}" in
      repos/example/project/releases?per_page=100)
        printf '%s\n' '[[{"tag_name":"crate-v7.3.0","draft":false,"prerelease":false,"published_at":"2020-01-01T00:00:00Z"}]]' ;;
      repos/fork/project/releases?per_page=100)
        if [[ -e "$directory/released" ]]; then
          printf '%s\n' '[[{"tag_name":"v7.3.0","draft":false,"prerelease":false}]]'
        else
          printf '%s\n' '[[]]'
        fi ;;
      *) exit 2 ;;
    esac ;;
  release)
    [[ "$2" == create && "$3" == v7.3.0 && "$*" == *--verify-tag* ]]
    test ! -e "$directory/released"
    touch "$directory/released" ;;
  *) exit 2 ;;
esac
SH
chmod +x "$root/bin/gh"
cd "$root/fork"
# The default branch has a later untagged commit: release mode must ignore it.
git -C "$root/upstream" commit -qm unreleased --allow-empty
observe() {
  PATH="$root/bin:$PATH" GITHUB_OUTPUT="$root/$1" node "$here/observe.mjs" example/project main merge crate-v
}
observe first
test "$(sed -n 's/^status=//p' "$root/first")" = quarantined
test "$(sed -n 's/^tip=//p' "$root/first")" = "$upstream"
# Advance the fixture's observation time, without sleeping three days.
git fetch -q origin refs/heads/automation/upstream-observations
old=$(git rev-parse FETCH_HEAD)
blob=$(git show "$old:observations.json" | node -e '
  const state = JSON.parse(require("fs").readFileSync(0));
  const elapsed = 4 * 86400000;
  state.lastAttempt -= elapsed;
  for (const item of state.observations) item.firstObserved -= elapsed;
  console.log(JSON.stringify(state));
' | git hash-object -w --stdin)
tree=$(printf '100644 blob %s\tobservations.json\n' "$blob" | git mktree)
state=$(git commit-tree "$tree" -p "$old" -m "Age observation fixture")
git push -q origin "$state:refs/heads/automation/upstream-observations"
observe mature
test "$(sed -n 's/^status=//p' "$root/mature")" = current
test "$(sed -n 's/^upstream=//p' "$root/mature")" = "$upstream"
test "$(sed -n 's/^release_tag=//p' "$root/mature")" = crate-v7.3.0
test "$(sed -n 's/^downstream_tag=//p' "$root/mature")" = v7.3.0
publish() { PATH="$root/bin:$PATH" node "$here/releases.mjs" publish fork/project example/project crate-v crate-v7.3.0 "$upstream" "$1" main; }
reject() { if "$@" >"$root/error" 2>&1; then echo "Unexpected success: $*" >&2; exit 1; fi; }
reject publish "$upstream" # fork head is not the requested SHA
publish "$head"
test "$(git --git-dir="$root/origin.git" rev-parse refs/tags/v7.3.0)" = "$head"
test -e "$root/released"
publish "$head" # idempotent retry
git -C "$root/upstream" commit -qm newer --allow-empty
git -C "$root/upstream" tag -fam moved crate-v7.3.0
reject publish "$head"
test "$(git --git-dir="$root/origin.git" rev-parse refs/tags/v7.3.0)" = "$head"
echo "Exact release tag, published release and retag rejection verified"
