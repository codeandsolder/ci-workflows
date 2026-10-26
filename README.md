# ci-workflows

Centrally managed reusable GitHub Actions workflows for `codeandsolder` repositories.

## Rust shared sccache

`.github/workflows/rust-sccache.yml` runs a caller-supplied Rust command on a GitHub-hosted runner using the maintained `codeandsolder/sccache-deduplicated` client.

Compiler outputs use sccache's native GitHub Actions cache backend (`SCCACHE_GHA_ENABLED=on`). The cache is repository-scoped by GitHub and keyed by sccache's own compilation keys; there is no custom rolling L0 snapshot, delta artifact, merger workflow, Garage promotion, tailnet access, or CI credential broker.

The workflow keeps one ordinary immutable `actions/cache` entry for released helper binaries (`sccache` and `cargo-ephemeral`) so identical tools are not downloaded on every job. That cache contains no compiler outputs.

### Cargo compatibility

The shared Rust workflow uses the maintained ephemeral Cargo client by default so registry source paths are normalized for cache reuse. Callers whose compile-time tooling spawns `$CARGO` for nested workspace queries can set `ephemeral-cargo: false`; this switches only Cargo back to the stock toolchain client.

### Canonical Rust compatibility

Canonical Rust path normalization is enabled by default. Set `canonical-rust: false` for a repository whose compiled code intentionally depends on physical build-tree paths at runtime. This changes sccache key normalization only; GitHub Actions remains the sole persistent compiler-cache backend.

### Cache invalidation

`SCCACHE_CACHE_LAYOUT_ID` is passed as `SCCACHE_GHA_VERSION`. Change it only when the cache format/key semantics intentionally change and the GitHub Actions compiler cache should be invalidated globally for this workflow revision.
