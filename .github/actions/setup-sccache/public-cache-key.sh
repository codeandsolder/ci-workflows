#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git -C "${CACHE_REPOSITORY_PATH:-.}" rev-parse --show-toplevel)"
graph_hash="$(
  git -C "$repo_root" ls-files -s -- 'Cargo.toml' 'Cargo.lock' ':(glob)**/Cargo.toml' \
    ':(glob)**/Cargo.lock' ':(glob)**/.cargo/config' ':(glob)**/.cargo/config.toml' |
    git -C "$repo_root" hash-object --stdin
)"
# Cargo +toolchain builds need not change the runner's default rustup toolchain.
# Use the actual configured compiler first, then the installed requested toolchain.
if [[ -n "${RUSTC:-}" ]]; then
  compiler_identity="$("$RUSTC" -vV)"
elif [[ -n "${CACHE_RUST_TOOLCHAIN:-}" ]] && command -v rustup >/dev/null 2>&1 &&
     compiler_identity="$(rustup run "$CACHE_RUST_TOOLCHAIN" rustc -vV 2>/dev/null)"; then
  :
elif command -v rustc >/dev/null 2>&1; then
  if [[ -n "${CACHE_RUST_TOOLCHAIN:-}" ]]; then
    echo "Cache key: requested rustup toolchain unavailable; using current rustc identity. Install the selected toolchain before cache setup." >&2
  fi
  compiler_identity="$(rustc -vV)"
else
  compiler_identity=rustc-unavailable
fi
effective_rustflags="${CACHE_RUSTFLAGS:-${RUSTFLAGS:-}}"
semantic_hash="$(
  printf '%s\0' "$RUNNER_OS" "$RUNNER_ARCH" "${ImageOS:-$RUNNER_OS}" \
    "${CACHE_RUST_TOOLCHAIN:-}" "$compiler_identity" "$effective_rustflags" \
    'sccache-v0.19.0' "$CACHE_SIZE_MIB" | git -C "$repo_root" hash-object --stdin
)"
scope="${CACHE_SCOPE:-$GITHUB_WORKFLOW:$GITHUB_JOB}"
if [[ "${CACHE_EXECUTION:-native}" == cross ]]; then
  # Container rustc paths and environment differ from host builds.
  semantic_hash="$(printf '%s\0' "$semantic_hash" cross | git -C "$repo_root" hash-object --stdin)"
fi
scope_hash="$(printf '%s' "$scope" | git -C "$repo_root" hash-object --stdin)"
prefix="rust-sccache-v3-$semantic_hash-"
workload_prefix="$prefix$scope_hash-"
graph_prefix="$workload_prefix$graph_hash-"
# Native Actions archives are immutable. A run-specific generation makes a
# trusted successful build able to publish new compiled objects after a restore.
# Same-run prime/restore jobs can intentionally share one scope and generation.
key="$graph_prefix$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
{
  echo "key=$key"
  echo "graph-prefix=$graph_prefix"
  echo "workload-prefix=$workload_prefix"
  echo "restore-prefix=$prefix"
} >> "$GITHUB_OUTPUT"
{
  echo "CODEANDSOLDER_SCCACHE_MODE=public-actions"
  echo "CODEANDSOLDER_SCCACHE_CACHE_KEY=$key"
  echo "CODEANDSOLDER_SCCACHE_CACHE_SIZE_MIB=$CACHE_SIZE_MIB"
} >> "$GITHUB_ENV"
