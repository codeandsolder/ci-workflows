#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'clone-regression: %s\n' "$*" >&2
  exit 2
}

# Mandatory policy: one owner, no repository or ambient environment overrides.
readonly discovery=50 blocking=100 test_blocking=140
readonly -a excludes=(
  '.ci-workflows/**'
  'tests/**' '**/tests/**'
  'examples/**' '**/examples/**'
  'benches/**' '**/benches/**'
  'vendor/**' '**/vendor/**'
  'node_modules/**' '**/node_modules/**'
  'target/**' '**/target/**'
)
if (( $# < 4 || $# > 5 )); then
  fail "usage: $0 REPOSITORY REPORT_DIRECTORY BASE_SHA PR_HEAD_SHA [PINNED_ARCHIVE]"
fi
root="$(cd "$1" && pwd -P)"
mkdir -p "$2"
report_dir="$(cd "$2" && pwd -P)"
base="$3"
pr_head="$4"
[[ "$base" =~ ^[0-9a-fA-F]{40}$ ]] || fail "a 40-digit base commit SHA is required"
[[ ! "$base" =~ ^0+$ ]] || fail "base commit is the all-zero initial-push sentinel"

for dependency in git jq curl sha256sum tar node; do
  command -v "$dependency" >/dev/null || fail "$dependency is required"
done

# The PR event payload can lag behind a freshly generated merge ref while
# the base branch advances. Compare the exact checked-out synthetic merge
# against its first parent, not the older base advertised in the payload.
# Verify the second parent matches the event's PR head before trusting it.
# Raw commit headers retain parents even in a depth-one checkout.
if [[ -n "$pr_head" ]]; then
  [[ "$pr_head" =~ ^[0-9a-f]{40}$ ]] || fail "invalid PR head SHA"
  commit="$(git -C "$root" cat-file commit HEAD)" || fail "cannot inspect checked-out PR merge commit"
  parents=()
  while IFS= read -r line; do
    [[ -n "$line" ]] || break
    if [[ "$line" == parent\ * ]]; then
      parents+=("${line#parent }")
    fi
  done <<< "$commit"
  (( ${#parents[@]} == 2 )) || fail "expected a two-parent PR merge commit"
  [[ "${parents[1]}" == "$pr_head" ]] ||
    fail "checked-out PR merge commit does not match event head $pr_head"
  if [[ "${parents[0]}" != "$base" ]]; then
    printf 'clone-regression: using checked-out merge parent %s instead of event base %s\n' "${parents[0]}" "$base"
  fi
  base="${parents[0]}"
fi

# Shallow checkout of a PR merge commit does not necessarily contain its base.
if ! git -C "$root" cat-file -e "$base^{commit}" 2>/dev/null; then
  git -C "$root" fetch --quiet --no-tags --depth=1 origin "$base" ||
    fail "cannot fetch base commit $base (check checkout permissions/history)"
fi
git -C "$root" cat-file -e "$base^{commit}" ||
  fail "base revision $base is not a commit"

# Pin both release version and the SHA256 of its official archive.
version="0.9.0"
target="x86_64-unknown-linux-gnu"
archive_sha256="e5d5abd63abfb74dddfc52d60d58144f402218aa49b3b6b6e610d1e3171f355f"
# Each invocation extracts from the verified archive into its own scratch
# directory. Fixture runs may reuse the same archive, never a caller binary.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] ||
  fail "the shared binary is currently pinned for Linux x86_64"
scratch="$(mktemp -d "$report_dir/clone-regression-tool.XXXXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
archive="${5:-$scratch/doppelscan.tar.gz}"
if [[ ! -f "$archive" ]]; then
  url="https://github.com/CMaintz/doppelscan/releases/download/v${version}/doppelscan-v${version}-${target}.tar.gz"
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 120 \
    "$url" --output "$scratch/download.tar.gz"
  printf '%s  %s\n' "$archive_sha256" "$scratch/download.tar.gz" | sha256sum --check --status ||
    fail "doppelscan release archive SHA256 mismatch"
  mv -- "$scratch/download.tar.gz" "$archive"
fi
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status ||
  fail "doppelscan release archive SHA256 mismatch"
tar -xzf "$archive" -C "$scratch" \
  "doppelscan-v${version}-${target}/doppelscan"
bin="$scratch/doppelscan-v${version}-${target}/doppelscan"

[[ -x "$bin" ]] || fail "doppelscan is not executable: $bin"
[[ "$("$bin" --version)" == "doppelscan $version" ]] ||
  fail "unexpected doppelscan version; expected $version"

scan_dir="$root"
args=(check "$scan_dir" --no-config --min-tokens "$discovery"
  --check-min-tokens "$blocking" --base "$base" --format json)
for pattern in "${excludes[@]}"; do
  args+=(--exclude "$pattern")
done

report="$report_dir/doppelscan-report.json"
raw_report="$report_dir/doppelscan-raw-report.json"
set +e
"$bin" "${args[@]}" > "$raw_report"
status=$?
set -e

if ! jq -e '.summary and (.new | type=="array") and (.smaller | type=="array")' "$raw_report" >/dev/null 2>&1; then
  fail "doppelscan failed to produce a valid JSON report (exit $status)"
fi
(( status == 0 || status == 1 )) || fail "doppelscan failed with unexpected exit code $status"

# Classification is separate from syntax matching: the scanner always uses
# centrally controlled settings, while reviewed, documented fingerprints
# from .doppelscan.toml can be accepted by the post-scan policy.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
node "$script_dir/../../policy-wasm/run.mjs" "$script_dir/../../policy-wasm/module.json" \
  clones "$root" "$scan_dir" "$blocking" "$test_blocking" < "$raw_report" > "$report" || fail "clone policy classification failed"

new="$(jq '.new | length' "$report")"
smaller="$(jq '.smaller | length' "$report")"
accepted="$(jq '.accepted | length' "$report")"
files="$(jq '.summary.files' "$report")"
printf 'clone-regression: %s files, %s blocking new groups (production >= %s, tests >= %s tokens), %s advisory, %s documented accepts (discovery >= %s)\n' \
  "$files" "$new" "$blocking" "$test_blocking" "$smaller" "$accepted" "$discovery"

summarize_groups() {
  local key="$1"
  jq -r --arg key "$key" '
    .[$key][:25][] |
    "- **\(.tokens) tokens**, \(.lines) lines, \(.occurrences|length) occurrences: " +
    ([.occurrences[:3][] | "\u0060\(.file):\(.start_line)\u0060"] | join(" · "))
  ' "$report"
}

{
  echo "## Duplicate code regression"
  echo
  echo "Base: \`$base\` · discovery: **$discovery tokens** · production blocking: **$blocking tokens** · test blocking: **$test_blocking tokens**"
  echo
  echo "| Files scanned | Newly blocked groups | New advisory groups | Documented accepts |"
  echo "| ---: | ---: | ---: | ---: |"
  echo "| $files | $new | $smaller | $accepted |"
  echo
  if (( new > 0 )); then
    echo "### Newly added duplication (blocking)"
    echo
    summarize_groups new
    echo
  fi
  if (( smaller > 0 )); then
    echo "### Smaller newly added matches (advisory)"
    echo
    summarize_groups smaller
    echo
  fi
  if (( accepted > 0 )); then
    echo "### Reviewed fingerprint exceptions"
    echo
    jq -r '.accepted[:25][] | "- **\(.tokens) tokens**, \(.policy_tier): \(.fingerprint) — \(.accept_reason)"' "$report"
    echo
  fi
  if (( new > 25 || smaller > 25 || accepted > 25 )); then
    echo "Showing the first 25 groups per class; see the JSON artifact for all findings."
  fi
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'new-groups=%s\n' "$new"
    printf 'advisory-groups=%s\n' "$smaller"
    printf 'accepted-groups=%s\n' "$accepted"
    printf 'scanned-files=%s\n' "$files"
  } >> "$GITHUB_OUTPUT"
fi

if (( new > 0 )); then
  exit 1
fi
