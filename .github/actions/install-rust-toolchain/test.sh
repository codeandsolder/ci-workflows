#!/usr/bin/env bash
set -euo pipefail
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/rustup" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$TEST_LOG"
case "$1" in
  run) [[ -f "$TEST_INSTALLED" ]] ;;
  toolchain) touch "$TEST_INSTALLED" ;;
  component|target) ;;
  *) exit 99 ;;
esac
MOCK
chmod +x "$tmp/bin/rustup"
export PATH="$tmp/bin:$PATH"
export TEST_LOG="$tmp/log" TEST_INSTALLED="$tmp/installed" GITHUB_ENV="$tmp/env"
assert_line() {
    local expected=$1 file=$2 line
    while IFS= read -r line; do
        if [[ "$line" == "$expected" ]]; then return 0; fi
    done < "$file"
    printf 'Missing expected line: %s\n' "$expected" >&2
    return 1
}

bash .github/actions/install-rust-toolchain/install.sh nightly-2026-11-23 clippy,rustfmt wasm32-wasip1 true
assert_line 'toolchain install nightly-2026-11-23 --profile minimal --no-self-update --component clippy --component rustfmt --target wasm32-wasip1' "$TEST_LOG"
assert_line 'RUSTUP_TOOLCHAIN=nightly-2026-11-23' "$GITHUB_ENV"
: > "$TEST_LOG"
: > "$GITHUB_ENV"
bash .github/actions/install-rust-toolchain/install.sh nightly-2026-11-23 clippy wasm32-unknown-unknown false
assert_line 'component add --toolchain nightly-2026-11-23 clippy' "$TEST_LOG"
assert_line 'target add --toolchain nightly-2026-11-23 wasm32-unknown-unknown' "$TEST_LOG"
[[ ! -s "$GITHUB_ENV" ]]
while IFS= read -r line; do
    if [[ "$line" == default\ * ]]; then
        printf 'Unexpected rustup default mutation: %s\n' "$line" >&2
        exit 1
    fi
done < "$TEST_LOG"
