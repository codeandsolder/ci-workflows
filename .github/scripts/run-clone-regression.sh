#!/usr/bin/env bash
set -Eeuo pipefail

fail() {
  printf 'clone-regression: %s\n' "$*" >&2
  exit 2
}

require_uint() {
  local value="$1" name="$2"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$name must be a positive integer: $value"
}

discovery="${CLONE_GUARD_DISCOVERY_TOKENS:-50}"
blocking="${CLONE_GUARD_BLOCKING_TOKENS:-100}"
test_blocking="${CLONE_GUARD_TEST_BLOCKING_TOKENS:-140}"
require_uint "$discovery" CLONE_GUARD_DISCOVERY_TOKENS
require_uint "$blocking" CLONE_GUARD_BLOCKING_TOKENS
require_uint "$test_blocking" CLONE_GUARD_TEST_BLOCKING_TOKENS
(( test_blocking >= blocking )) || fail "test blocking threshold ($test_blocking) must be >= production threshold ($blocking)"
(( blocking >= discovery )) || fail "blocking threshold ($blocking) must be >= discovery threshold ($discovery)"

root="${GITHUB_WORKSPACE:-$(pwd)}"
root="$(cd "$root" && pwd -P)"
scan_path="${CLONE_GUARD_SCAN_PATH:-.}"
[[ -d "$root/$scan_path" ]] || fail "scan path does not exist: $scan_path"
base="${CLONE_GUARD_BASE_SHA:-}"
[[ "$base" =~ ^[0-9a-fA-F]{40}$ ]] || fail "a 40-digit base commit SHA is required"
[[ ! "$base" =~ ^0+$ ]] || fail "base commit is the all-zero initial-push sentinel"

for dependency in git jq curl sha256sum tar python3; do
  command -v "$dependency" >/dev/null || fail "$dependency is required"
done

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
# DOPPELSCAN_BIN is set by local smoke tests only, never by the reusable workflow.
if [[ -n "${DOPPELSCAN_BIN:-}" ]]; then
  bin="$DOPPELSCAN_BIN"
else
  [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] ||
    fail "the shared binary is currently pinned for Linux x86_64"
  scratch="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/clone-regression-tool"
  mkdir -p "$scratch"
  archive="$scratch/doppelscan.tar.gz"
  url="https://github.com/CMaintz/doppelscan/releases/download/v${version}/doppelscan-v${version}-${target}.tar.gz"
  curl --fail --location --silent --show-error --retry 3 --connect-timeout 20 --max-time 120 \
    "$url" --output "$archive"
  printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status ||
    fail "doppelscan release archive SHA256 mismatch"
  tar -xzf "$archive" -C "$scratch" \
    "doppelscan-v${version}-${target}/doppelscan"
  bin="$scratch/doppelscan-v${version}-${target}/doppelscan"
fi

[[ -x "$bin" ]] || fail "doppelscan is not executable: $bin"
[[ "$("$bin" --version)" == "doppelscan $version" ]] ||
  fail "unexpected doppelscan version; expected $version"

scan_dir="$(cd "$root/$scan_path" && pwd -P)"
args=(check "$scan_dir" --no-config --min-tokens "$discovery"
  --check-min-tokens "$blocking" --base "$base" --format json)
if [[ -n "${CLONE_GUARD_LANGUAGES:-}" ]]; then
  args+=(--only "$CLONE_GUARD_LANGUAGES")
fi
# Paths are data, never shell syntax. Empty lines are ignored.
while IFS= read -r pattern || [[ -n "$pattern" ]]; do
  [[ -n "$pattern" ]] && args+=(--exclude "$pattern")
done <<< "${CLONE_GUARD_EXCLUDES:-}"

report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/doppelscan-report.json"
raw_report="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/doppelscan-raw-report.json"
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
python3 "$script_dir/clone-regression-policy.py" "$raw_report" "$report" \
  "$root" "$scan_dir" "$blocking" "$test_blocking" || fail "clone policy classification failed"

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
