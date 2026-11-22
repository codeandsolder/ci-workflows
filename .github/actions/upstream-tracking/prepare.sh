#!/usr/bin/env bash
set -euo pipefail
repository=$1
branch=$2
upstream=$3
base=$4
strategy=$5
workflow_policy=$6
bundle=$7

test "$(git rev-parse HEAD)" = "$base"
git fetch --no-tags "https://github.com/$repository.git" "refs/heads/$branch"
git merge-base --is-ancestor "$upstream" FETCH_HEAD
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
# Never run a newly introduced workflow automatically. Cargo's maintained
# patch stack deliberately retains the reviewed workflow tree; other forks
# surface the change as a blocking issue.
fork_base=$(git merge-base "$base" "$upstream")
checkpoint=.github/upstream-reconciliation/reviewed-source-sha
reviewed=
if [[ "$strategy" == source-merge && -f "$checkpoint" ]]; then
  reviewed=$(cat "$checkpoint")
  [[ "$reviewed" =~ ^[0-9a-f]{40}$ ]]
  git merge-base --is-ancestor "$reviewed" "$upstream"
  fork_base=$reviewed
fi
drift=false
if ! git diff --quiet "$fork_base" "$upstream" -- .github/workflows; then
  drift=true
fi
echo "workflow_drift=$drift" >> "$GITHUB_OUTPUT"
if [[ "$workflow_policy" == reject && "$drift" == true ]]; then
  echo "Upstream workflow changes require manual reconciliation" >&2
  git diff --name-status "$fork_base" "$upstream" -- .github/workflows
  exit 1
fi
case "$strategy" in
  merge)
    git merge --no-ff --no-edit "$upstream"
    ;;
  source-merge)
    if [[ -z "$reviewed" ]]; then
      git merge --no-ff --no-edit "$upstream"
    elif [[ "$reviewed" != "$upstream" ]]; then
      tree=$(git merge-tree --write-tree --merge-base="$reviewed" "$base" "$upstream")
      git read-tree -u --reset "$tree"
      git restore --source="$base" --staged --worktree .github/workflows
      printf '%s\n' "$upstream" > "$checkpoint"
      git add "$checkpoint"
      git commit -m "Integrate reviewed-source upstream snapshot $upstream"
    fi
    ;;
  rebase)
    git rebase "$upstream"
    ;;
  squash-rebase)
    # Keep the downstream patch against the common ancestor, not a pile
    # of historical merge commits. Exclude fork-owned workflow files.
    git reset --soft "$fork_base"
    git restore --source="$fork_base" --staged --worktree .github/workflows
    if ! git diff --cached --quiet; then
      git commit -m 'Carry downstream patch'
    fi
    git rebase "$upstream"
    git restore --source="$base" --staged --worktree .github/workflows
    if ! git diff --cached --quiet; then
      git commit -m 'Retain reviewed downstream workflows'
    fi
    ;;
  *) echo "Unknown integration strategy: $strategy" >&2; exit 2 ;;
esac

if ! git diff --quiet "$base" HEAD -- .github/workflows; then
  echo "Candidate changes reviewed workflow files; manual reconciliation required" >&2
  git diff --name-status "$base" HEAD -- .github/workflows
  exit 1
fi
git diff --check "$base" HEAD
head=$(git rev-parse HEAD)
echo "head=$head" >> "$GITHUB_OUTPUT"
if [[ "$head" != "$base" ]]; then
  echo "changed=true" >> "$GITHUB_OUTPUT"
  git bundle create "$bundle" HEAD "^$base"
else
  echo "changed=false" >> "$GITHUB_OUTPUT"
fi
