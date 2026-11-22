#!/usr/bin/env bash
# Integration test with real Git baselines, real doppelscan and generated Rust.
set -Eeuo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
python3 "$script_dir/test-clone-regression-policy.py"
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
project="$repo"
run_dir="$test_dir/run"
pr_head=""
archive="$test_dir/doppelscan.tar.gz"
export GITHUB_STEP_SUMMARY="$test_dir/summary.md"

check() {
  local case_name="$1" expected="$2" actual
  set +e
  bash "$script_dir/run-clone-regression.sh" "$project" "$run_dir" "$base" "$pr_head" "$archive" > "$test_dir/$case_name.out" 2> "$test_dir/$case_name.err"
  actual=$?
  set -e
  if [[ "$actual" -ne "$expected" ]]; then
    echo "FAIL $case_name: expected exit $expected, got $actual" >&2
    cat "$test_dir/$case_name.out" "$test_dir/$case_name.err" >&2
    exit 1
  fi
  jq -e '.summary and (.new|type=="array") and (.smaller|type=="array")' "$run_dir/doppelscan-report.json" >/dev/null
  echo "PASS $case_name (exit $actual; blocking=$(jq '.new|length' "$run_dir/doppelscan-report.json"); advisory=$(jq '.smaller|length' "$run_dir/doppelscan-report.json"))"
}
reset_case() {
  git -C "$repo" reset --hard -q "$base"
  git -C "$repo" clean -fdq
}

check accepted-baseline 0
sed 's/fn fold_bytes(/fn fold_bytes_copy(/' "$repo/src/engine.rs" > "$repo/src/copy.rs"
check third-copy-blocked 1
jq -e '.new|length>0' "$run_dir/doppelscan-report.json" >/dev/null
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
jq -e '.smaller|length>0' "$run_dir/doppelscan-report.json" >/dev/null ||
  { echo "FAIL smaller copy is not in advisory report" >&2; exit 1; }
reset_case
# All copies are inside one explicitly annotated Rust unit-test module.
# A medium clone should remain visible as advisory rather than fail.
cat > "$repo/src/test_suite.rs" <<'RUST'
#[cfg(test)]
mod tests {
    fn inspect_first(values: &[u32]) -> u32 {
        let mut x = 7_u32;
        let mut total = 0_u32;
        for (index, item) in values.iter().copied().enumerate() {
            x = x.wrapping_mul(1664525).wrapping_add(item);
            x ^= x.rotate_left(13);
            if (index & 1) == 0 {
                total = total.wrapping_add(x);
            } else {
                total = total.wrapping_sub(x);
            }
        }
        if total == 0 {
            x.wrapping_mul(31)
        } else {
            x.wrapping_add(total)
        }
    }

    fn inspect_second(values: &[u32]) -> u32 {
        let mut x = 7_u32;
        let mut total = 0_u32;
        for (index, item) in values.iter().copied().enumerate() {
            x = x.wrapping_mul(1664525).wrapping_add(item);
            x ^= x.rotate_left(13);
            if (index & 1) == 0 {
                total = total.wrapping_add(x);
            } else {
                total = total.wrapping_sub(x);
            }
        }
        if total == 0 {
            x.wrapping_mul(31)
        } else {
            x.wrapping_add(total)
        }
    }
}
RUST
check inline-rust-unit-test-advisory 0
jq -e '.smaller|map(select(.policy_tier == "test" and .tokens >= 100))|length>0' \
  "$run_dir/doppelscan-report.json" >/dev/null || {
    echo 'FAIL inline Rust unit-test duplication was not classified as advisory' >&2
    exit 1
  }
reset_case

# A copy crossing the test/production boundary is still production duplication.
{
  printf '#[cfg(test)]\nmod tests {\n'
  sed 's/pub fn fold_bytes(/fn fold_bytes_unit_case(/' "$repo/src/engine.rs"
  printf '}\n'
} > "$repo/src/mixed.rs"
check mixed-production-test-clone-blocked 1
jq -e '.new|map(select(.policy_tier == "production"))|length>0' \
  "$run_dir/doppelscan-report.json" >/dev/null
reset_case

# Longer test-only clones still block.
cat > "$test_dir/long_test_fn" <<'RUST'
    fn examine_first(values: &[u32]) -> u32 {
        let mut x = 7_u32;
        let mut total = 0_u32;
        for (index, item) in values.iter().copied().enumerate() {
            x = x.wrapping_mul(1664525).wrapping_add(item);
            x ^= x.rotate_left(13);
            if (index & 1) == 0 {
                total = total.wrapping_add(x);
            } else {
                total = total.wrapping_sub(x);
            }
            x = x.wrapping_mul(1103515245).wrapping_add(12345);
            total = total.rotate_left(9) ^ x;
        }
        for round in 0..32 {
            x = x.wrapping_mul(7).wrapping_add(round);
            if x & 0x4000 == 0 {
                total = total.wrapping_add(x << 2);
            } else {
                total = total.wrapping_sub(x >> 2);
            }
        }
        if total == 0 {
            x.wrapping_mul(31)
        } else {
            x.wrapping_add(total)
        }
    }
RUST
{
  printf '#[cfg(test)]\nmod tests {\n'
  cat "$test_dir/long_test_fn"
  sed 's/examine_first/examine_second/' "$test_dir/long_test_fn"
  printf '}\n'
} > "$repo/src/large_test.rs"
check large-test-duplication-blocked 1
jq -e '.new|map(select(.policy_tier == "test" and .tokens >= 140))|length>0' \
  "$run_dir/doppelscan-report.json" >/dev/null
reset_case

# Repo configuration may document explicit fingerprint accepts, but may
# *never* override central discovery, thresholds or exclusions.
sed 's/fn fold_bytes(/fn fold_bytes_copy(/' "$repo/src/engine.rs" > "$repo/src/copy.rs"
cat > "$repo/.doppelscan.toml" <<'TOML'
min-tokens = 999999
exclude = ["src/**"]
TOML
check repository-config-cannot-disable-scanner 1
{
  printf 'min-tokens = 999999\nexclude = ["src/**"]\n'
  jq -r '.new[] | "[[accept]]\nfingerprint = \"" + .fingerprint + "\"\nreason = \"Intentional public ABI duplication in this regression fixture.\""' \
    "$run_dir/doppelscan-report.json"
} > "$repo/.doppelscan.toml"
check reviewed-fingerprint-accept-passes 0
jq -e '.new|length==0' "$run_dir/doppelscan-report.json" >/dev/null
jq -e '.accepted|length>0' "$run_dir/doppelscan-report.json" >/dev/null
reset_case

# A synthetic PR merge can be generated after the event payload's base
# advanced. A workflow-only PR must not be blamed for clones already in
# the actual base. Keep the event head fixed to validate the second parent.
git -C "$repo" switch -q -c fixture-base "$base"
sed 's/fn fold_bytes(/fn fold_bytes_base_copy(/' "$repo/src/engine.rs" > "$repo/src/base_copy.rs"
git -C "$repo" add .
git -C "$repo" commit -qm "base advances with additional existing duplication"
actual_base="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" switch -q -c fixture-pr "$base"
printf 'workflow-only change\n' > "$repo/README.md"
git -C "$repo" add README.md
git -C "$repo" commit -qm "PR changes no Rust source"
fixture_pr_head="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" switch -q fixture-base
git -C "$repo" merge -q --no-ff -m "synthetic PR merge" fixture-pr
check stale-event-base-reproduces-false-positive 1
pr_head="$fixture_pr_head"
check actual-merge-parent-passes 0
[[ "$(git -C "$repo" rev-parse HEAD^1)" == "$actual_base" ]]
[[ "$(<"$test_dir/actual-merge-parent-passes.out")" == *"using checked-out merge parent $actual_base instead of event base $base"* ]]

# Real GitHub checkouts are shallow by default. The first parent must be
# selected from the raw commit header and fetched if it is absent.
git clone -q --depth=1 --branch fixture-base "file://$repo" "$test_dir/shallow"
project="$test_dir/shallow"
check shallow-merge-parent-passes 0
project="$repo"

git -C "$repo" switch -q fixture-pr
sed 's/fn fold_bytes(/fn fold_bytes_pr_copy(/' "$repo/src/engine.rs" > "$repo/src/pr_copy.rs"
git -C "$repo" add src/pr_copy.rs
git -C "$repo" commit -qm "PR introduces real duplication"
pr_head="$(git -C "$repo" rev-parse HEAD)"
git -C "$repo" switch -q -c fixture-merge "$actual_base"
git -C "$repo" merge -q --no-ff -m "synthetic PR merge with real clone" fixture-pr
check actual-pr-duplication-blocked 1

# A different head means this is not the merge commit for the advertised
# PR revision. Never accept the unrelated commit as a baseline.
set +e
bash "$script_dir/run-clone-regression.sh" "$project" "$run_dir" "$base" "$base" "$archive" \
  > "$test_dir/mismatched-head.out" 2> "$test_dir/mismatched-head.err"
status=$?
set -e
[[ "$status" == 2 ]] || { echo "FAIL mismatched PR head: exit $status" >&2; exit 1; }
[[ "$(<"$test_dir/mismatched-head.err")" == *"checked-out PR merge commit does not match event head"* ]]
echo "PASS mismatched PR head rejected"

# Reused archives are verified on every call, not merely when downloaded.
printf 'invalid archive' > "$test_dir/bad.tar.gz"
status=0
bash "$script_dir/run-clone-regression.sh" "$project" "$run_dir" "$base" "$pr_head" "$test_dir/bad.tar.gz" \
  > "$test_dir/bad-archive.out" 2> "$test_dir/bad-archive.err" || status=$?
[[ "$status" == 2 && "$(<"$test_dir/bad-archive.err")" == *"archive SHA256 mismatch"* ]]
echo "PASS corrupted reused archive rejected"

echo "All clone-regression integration cases passed."
