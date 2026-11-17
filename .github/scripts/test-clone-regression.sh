#!/usr/bin/env bash
# Integration test with real Git baselines, real doppelscan and generated Rust.
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
test_dir="$(mktemp -d)"
trap 'rm -rf -- "$test_dir"' EXIT
repo="$test_dir/repo"
mkdir -p "$repo/src" "$test_dir/run"
git -C "$test_dir" init -q repo
git -C "$repo" config user.name "Clone Regression Test"
git -C "$repo" config user.email "ci@example.invalid"

cat > "$repo/src/engine.rs" <<'RUST'
pub fn fold_bytes(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut pending = false;
    let mut nesting = 0usize;
    let mut escapes = 0usize;
    for (index, value) in input.iter().copied().enumerate() {
        if value == b'\\' {
            escapes += 1;
            pending = !pending;
            continue;
        }
        if pending {
            output.push(value);
            pending = false;
            continue;
        }
        if value == b'(' {
            nesting += 1;
            output.push(value);
            continue;
        }
        if value == b')' {
            nesting = nesting.saturating_sub(1);
            output.push(value);
            continue;
        }
        if value.is_ascii_whitespace() {
            if nesting > 0 {
                output.push(b'_');
            } else if output.last().copied() != Some(b' ') {
                output.push(b' ');
            }
            continue;
        }
        if value == b':' && index > 0 {
            output.push(b'=');
        } else if value.is_ascii_uppercase() {
            output.push(value.to_ascii_lowercase());
        } else {
            output.push(value);
        }
    }
    if pending && escapes > 0 {
        output.push(b'\\');
    }
    if output.last().copied() == Some(b' ') {
        output.pop();
    }
    output
}
RUST
sed 's/fn fold_bytes(/fn fold_bytes_legacy(/' "$repo/src/engine.rs" > "$repo/src/legacy.rs"
git -C "$repo" add .
git -C "$repo" commit -qm "baseline: accepted duplicate"
base="$(git -C "$repo" rev-parse HEAD)"
export GITHUB_WORKSPACE="$repo"
export RUNNER_TEMP="$test_dir/run"
export GITHUB_STEP_SUMMARY="$test_dir/summary.md"
export CLONE_GUARD_BASE_SHA="$base"
export CLONE_GUARD_DISCOVERY_TOKENS=50
export CLONE_GUARD_BLOCKING_TOKENS=80
export CLONE_GUARD_EXCLUDES=$'tests/**\n**/tests/**'
export CLONE_GUARD_SCAN_PATH=.
export CLONE_GUARD_LANGUAGES=rust

check() {
  local case_name="$1" expected="$2" actual
  set +e
  bash "$script_dir/run-clone-regression.sh" > "$test_dir/$case_name.out" 2> "$test_dir/$case_name.err"
  actual=$?
  set -e
  if [[ "$actual" -ne "$expected" ]]; then
    echo "FAIL $case_name: expected exit $expected, got $actual" >&2
    cat "$test_dir/$case_name.out" "$test_dir/$case_name.err" >&2
    exit 1
  fi
  jq -e '.summary and (.new|type=="array") and (.smaller|type=="array")' "$RUNNER_TEMP/doppelscan-report.json" >/dev/null
  echo "PASS $case_name (exit $actual; blocking=$(jq '.new|length' "$RUNNER_TEMP/doppelscan-report.json"); advisory=$(jq '.smaller|length' "$RUNNER_TEMP/doppelscan-report.json"))"
}
reset_case() {
  git -C "$repo" reset --hard -q "$base"
  git -C "$repo" clean -fdq
}

check accepted-baseline 0
# Once installation has been tested once, reuse that exact pinned binary for
# the remaining fixture cases.
if [[ -z "${DOPPELSCAN_BIN:-}" ]]; then
  export DOPPELSCAN_BIN="$RUNNER_TEMP/clone-regression-tool/doppelscan-v0.9.0-x86_64-unknown-linux-gnu/doppelscan"
fi
sed 's/fn fold_bytes(/fn fold_bytes_copy(/' "$repo/src/engine.rs" > "$repo/src/copy.rs"
check third-copy-blocked 1
jq -e '.new|length>0' "$RUNNER_TEMP/doppelscan-report.json" >/dev/null
reset_case

# The same logic with different local names must still be reported.
sed -e 's/fn fold_bytes(/fn fold_bytes_renamed(/' \
    -e 's/\boutput\b/result/g' -e 's/\bpending\b/escaped/g' \
    -e 's/\bnesting\b/depth/g' -e 's/\bescapes\b/slashes/g' \
    -e 's/\bvalue\b/byte/g' -e 's/\binput\b/source/g' \
    -e 's/\bindex\b/offset/g' "$repo/src/engine.rs" > "$repo/src/renamed.rs"
check renamed-copy-blocked 1
reset_case

# Changing one of two already-accepted copies is not a newly added copy.
sed -i "s/output.push(b'_');/output.push(b'-');/" "$repo/src/legacy.rs"
check edited-existing-copy-passes 0
reset_case

mkdir -p "$repo/tests"
sed 's/fn fold_bytes(/fn fold_bytes_test(/' "$repo/src/engine.rs" > "$repo/tests/clone.rs"
check excluded-test-copy-passes 0
reset_case

git -C "$repo" mv src/legacy.rs src/moved.rs
check moved-existing-copy-passes 0
reset_case

# Smaller groups are still reported but must not fail the job.
cat > "$repo/src/small.rs" <<'RUST'
fn calc_x(a: u32, b: u32, c: u32) -> u32 {
    let result = a.wrapping_add(b);
    let shifted = result.rotate_left(3);
    let mixed = shifted ^ c;
    if mixed > 500 {
        mixed.wrapping_sub(7)
    } else {
        mixed.wrapping_add(11)
    }
}
fn calc_y(a: u32, b: u32, c: u32) -> u32 {
    let result = a.wrapping_add(b);
    let shifted = result.rotate_left(3);
    let mixed = shifted ^ c;
    if mixed > 500 {
        mixed.wrapping_sub(7)
    } else {
        mixed.wrapping_add(11)
    }
}
RUST
check small-new-copy-passes 0
jq -e '.smaller|length>0' "$RUNNER_TEMP/doppelscan-report.json" >/dev/null ||
  { echo "FAIL smaller copy is not in advisory report" >&2; exit 1; }
reset_case
echo "All clone-regression integration cases passed."
