#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

fixture() {
  local scenario=$1
  mkdir "$root/$scenario"
  cd "$root/$scenario"
  git init -q -b main upstream
  git -C upstream config user.name test
  git -C upstream config user.email test@example.invalid
  mkdir -p upstream/.github/workflows
  echo original > upstream/.github/workflows/ci.yml
  echo common > upstream/common
  echo dependency-v1 > upstream/dependency.lock
  git -C upstream add .
  git -C upstream commit -qm base
  divergence=$(git -C upstream rev-parse HEAD)
  git clone -q upstream fork
  git -C fork config user.name test
  git -C fork config user.email test@example.invalid
  git -C fork config url."file://$PWD/upstream".insteadOf https://github.com/example/project.git
  echo local > fork/local
  echo reviewed > fork/.github/workflows/ci.yml
  git -C fork add .
  git -C fork commit -qm fork
  base=$(git -C fork rev-parse HEAD)
  echo upstream > upstream/new
  echo dependency-v2 > upstream/dependency.lock
  git -C upstream add .
  git -C upstream commit -qm upstream
  selected=$(git -C upstream rev-parse HEAD)
  output="$PWD/output"
  bundle="$PWD/candidate.bundle"
  cd fork
}

prepare() {
  GITHUB_OUTPUT="$output" node "$here/prepare.mjs" example/project main "$selected" "$base" "$1" "$bundle" "${2:-}"
}

verify() {
  test "$(cat new)" = upstream
  test "$(cat local)" = local
  test "$(cat dependency.lock)" = dependency-v2
  test "$(cat .github/workflows/ci.yml)" = reviewed
  git merge-base --is-ancestor "$selected" HEAD
  test -z "$(git rev-list --merges "$selected"..HEAD)"
  local candidate
  candidate=$(git rev-parse HEAD)
  git bundle verify "$bundle"
  git checkout -q --detach "$base"
  git fetch -q "$bundle" HEAD
  test "$(git rev-parse FETCH_HEAD)" = "$candidate"
}

fixture linear
echo second > second
git add second
git commit -qm 'second independent patch'
git commit -qm 'empty historical commit' --allow-empty
base=$(git rev-parse HEAD)
prepare reject
test "$(git log --reverse --format=%s "$selected"..HEAD)" = "$(printf 'fork\nsecond independent patch')"
test "$(cat second)" = second
verify

fixture absorbed
echo adopted > adopted
git add adopted
git commit -qm 'fork patch eventually upstreamed'
git commit -qm 'empty historical commit' --allow-empty
base=$(git rev-parse HEAD)
echo adopted > ../upstream/adopted
git -C ../upstream add adopted
git -C ../upstream commit -qm 'upstream adopts fix with different commit identity'
selected=$(git -C ../upstream rev-parse HEAD)
prepare reject
test "$(git log --format=%s "$selected"..HEAD)" = fork
test "$(cat adopted)" = adopted
verify

fixture absorbed-then-edited
echo fork-fix > common
git commit -qam 'fork patch adopted then refined upstream'
base=$(git rev-parse HEAD)
echo fork-fix > ../upstream/common
git -C ../upstream commit -qam 'equivalent upstream fix'
echo refined-upstream > ../upstream/common
git -C ../upstream commit -qam 'refine upstream fix'
selected=$(git -C ../upstream rev-parse HEAD)
prepare reject
test "$(cat common)" = refined-upstream
test "$(git log --format=%s "$selected"..HEAD)" = fork
verify

fixture all-empty
git reset --hard "$divergence"
echo absorbed > absorbed
git add absorbed
git commit -qm 'all fork patches upstreamed'
base=$(git rev-parse HEAD)
echo absorbed > ../upstream/absorbed
git -C ../upstream add absorbed
git -C ../upstream commit -qm 'absorb all fork changes'
selected=$(git -C ../upstream rev-parse HEAD)
prepare reject
test "$(git rev-parse HEAD)" = "$selected"
git bundle verify "$bundle"

fixture preserve
echo upstream-change > ../upstream/.github/workflows/ci.yml
echo new-workflow > ../upstream/.github/workflows/extra.yml
git -C ../upstream add .github/workflows
git -C ../upstream commit -qm drift
selected=$(git -C ../upstream rev-parse HEAD)
prepare preserve
test ! -e .github/workflows/extra.yml
test "$(sed -n 's/^workflow_drift=//p' "$output")" = true
verify

fixture reject
echo upstream-change > ../upstream/.github/workflows/ci.yml
git -C ../upstream commit -qam drift
selected=$(git -C ../upstream rev-parse HEAD)
if prepare reject; then exit 1; fi
test "$(git rev-parse HEAD)" = "$base"
test ! -e "$bundle"

fixture conflict
echo conflict-local > common
git commit -qam local-conflict
base=$(git rev-parse HEAD)
echo conflict-upstream > ../upstream/common
echo upstream-change > ../upstream/.github/workflows/ci.yml
git -C ../upstream commit -qam upstream-conflict
selected=$(git -C ../upstream rev-parse HEAD)
if prepare preserve; then exit 1; fi
test ! -e "$bundle"

fixture preserve-deletion
echo fork-script > .github/workflows/extra.yml
git add .github/workflows/extra.yml
git commit -qm 'fork-only workflow'
base=$(git rev-parse HEAD)
echo upstream-script > ../upstream/.github/workflows/extra.yml
git -C ../upstream add .github/workflows/extra.yml
git -C ../upstream commit -qm 'upstream introduces conflicting workflow'
selected=$(git -C ../upstream rev-parse HEAD)
prepare preserve
test "$(cat .github/workflows/extra.yml)" = fork-script
verify

fixture historical-add-add
echo fork-change > fork-extra
git add fork-extra
git commit -qm 'fork creates file'
echo upstream-change > ../upstream/fork-extra
git -C ../upstream add fork-extra
git -C ../upstream commit -qm 'upstream creates file too'
git fetch -q ../upstream main
if git merge --no-ff --no-edit FETCH_HEAD; then exit 1; fi
git rm fork-extra
git commit -qm 'reviewed deletion of conflicting addition'
base=$(git rev-parse HEAD)
echo more > ../upstream/more
git -C ../upstream add more
git -C ../upstream commit -qm more
selected=$(git -C ../upstream rev-parse HEAD)
prepare reject
test ! -e fork-extra
verify

fixture historical-merge
echo local-resolution > common
git commit -qam 'fork source patch'
echo second > second
git add second
git commit -qm 'another source patch'
git fetch -q ../upstream main
echo upstream-resolution > ../upstream/common
git -C ../upstream commit -qam 'old upstream change'
git fetch -q ../upstream main
if git merge --no-ff --no-edit FETCH_HEAD; then exit 1; fi
echo reviewed-resolution > common
git add common
git commit -qm 'historically reviewed conflict resolution'
base=$(git rev-parse HEAD)
echo subsequent > ../upstream/next
git -C ../upstream add next
git -C ../upstream commit -qm next
selected=$(git -C ../upstream rev-parse HEAD)
prepare reject
test "$(cat common)" = reviewed-resolution
test "$(cat second)" = second
test "$(cat next)" = subsequent
git log --format=%s "$selected"..HEAD | grep -Fx 'Preserve reviewed historical integration resolutions'
verify

fixture checkpoint
mkdir -p .github/upstream-reconciliation
printf '%s\n' "$selected" > .github/upstream-reconciliation/reviewed-source-sha
cp ../upstream/new new
cp ../upstream/dependency.lock dependency.lock
git add .
git commit -qm reviewed-source
echo independent > independent
git add independent
git commit -qm 'post-checkpoint patch'
base=$(git rev-parse HEAD)
echo subsequent > ../upstream/next
git -C ../upstream add next
git -C ../upstream commit -qm next
selected=$(git -C ../upstream rev-parse HEAD)
prepare reject
test "$(cat next)" = subsequent
test "$(cat independent)" = independent
test ! -e .github/upstream-reconciliation/reviewed-source-sha
git log --format=%s "$selected"..HEAD | grep -Fx 'post-checkpoint patch'
verify

fixture generated-conflict
printf 'fork artifact\0' > artifact.bin
git add artifact.bin
git commit -qm artifact
base=$(git rev-parse HEAD)
printf 'upstream artifact\0' > ../upstream/artifact.bin
git -C ../upstream add artifact.bin
git -C ../upstream commit -qm artifact
selected=$(git -C ../upstream rev-parse HEAD)
prepare preserve artifact.bin
source=$(git rev-parse HEAD)
cmp artifact.bin <(printf 'upstream artifact\0')
printf 'regenerated artifact\0' > artifact.bin
GITHUB_OUTPUT="$output" node "$here/generated.mjs" commit "$source" "$base" artifact.bin "$bundle.new"
head=$(git rev-parse HEAD)
node "$here/generated.mjs" verify "$source" "$head" artifact.bin
mv "$bundle.new" "$bundle"
verify

fixture generated-fork-only
printf 'fork-only artifact\0' > artifact.bin
git add artifact.bin
git commit -qm artifact
base=$(git rev-parse HEAD)
prepare preserve artifact.bin
cmp artifact.bin <(printf 'fork-only artifact\0')
verify

echo "All thirteen real patch-rebase scenarios passed"
