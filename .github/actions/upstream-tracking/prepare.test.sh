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
  git -C upstream add .
  git -C upstream commit -qm base
  ancestor=$(git -C upstream rev-parse HEAD)
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
  git -C upstream add .
  git -C upstream commit -qm upstream
  selected=$(git -C upstream rev-parse HEAD)
  output="$PWD/output"
  bundle="$PWD/candidate.bundle"
  cd fork
}

prepare() {
  GITHUB_OUTPUT="$output" node "$here/prepare.mjs" example/project main "$selected" "$base" "$1" "$2" "$bundle"
}

verify() {
  test "$(cat new)" = upstream
  test "$(cat local)" = local
  test "$(cat .github/workflows/ci.yml)" = reviewed
  local candidate
  candidate=$(git rev-parse HEAD)
  git bundle verify "$bundle"
  git checkout -q --detach "$base"
  git fetch -q "$bundle" HEAD
  test "$(git rev-parse FETCH_HEAD)" = "$candidate"
}

fixture merge
prepare merge reject
git merge-base --is-ancestor "$base" HEAD
git merge-base --is-ancestor "$selected" HEAD
verify

fixture rebase
prepare rebase reject
git merge-base --is-ancestor "$selected" HEAD
verify

fixture preserve
echo upstream-change > ../upstream/.github/workflows/ci.yml
git -C ../upstream commit -qam drift
selected=$(git -C ../upstream rev-parse HEAD)
prepare squash-rebase preserve
git merge-base --is-ancestor "$selected" HEAD
verify

fixture reject
echo upstream-change > ../upstream/.github/workflows/ci.yml
git -C ../upstream commit -qam drift
selected=$(git -C ../upstream rev-parse HEAD)
if prepare merge reject; then
  echo "Undetected workflow drift" >&2
  exit 1
fi
test "$(git rev-parse HEAD)" = "$base"
test ! -e "$bundle"

fixture conflict
echo conflict-local > common
git commit -qam local-conflict
base=$(git rev-parse HEAD)
echo conflict-upstream > ../upstream/common
git -C ../upstream commit -qam upstream-conflict
selected=$(git -C ../upstream rev-parse HEAD)
if prepare merge reject; then
  echo "Undetected conflict" >&2
  exit 1
fi
test ! -e "$bundle"

fixture checkpoint
mkdir -p .github/upstream-reconciliation
printf '%s\n' "$selected" > .github/upstream-reconciliation/reviewed-source-sha
cp ../upstream/new new
git add .
git commit -qm reviewed-source
base=$(git rev-parse HEAD)
echo subsequent > ../upstream/next
git -C ../upstream add next
git -C ../upstream commit -qm next
selected=$(git -C ../upstream rev-parse HEAD)
prepare source-merge reject
test "$(cat next)" = subsequent
test "$(cat .github/upstream-reconciliation/reviewed-source-sha)" = "$selected"
git merge-base --is-ancestor "$base" HEAD
verify
echo "All six real Git integration scenarios passed"
