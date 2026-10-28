# ci-workflows

Centrally managed reusable GitHub Actions workflows for `codeandsolder` repositories.

## Rust sccache policy

`.github/workflows/rust-sccache.yml` chooses the execution/cache path from the caller repository visibility.

### Public repositories

Public repositories run on the requested GitHub-hosted runner using the maintained `codeandsolder/sccache-deduplicated` client.

Compiler outputs live in a bounded local sccache directory and are persisted between compatible GitHub-hosted jobs with ordinary `actions/cache`. The primary cache key is immutable and derived from the runner image label and platform, Rust toolchain, `RUSTFLAGS`, sccache release, cache-size policy, and tracked Cargo manifests/lockfiles. When the Cargo graph changes, the workflow restores the newest semantically compatible snapshot and saves one new graph-specific snapshot after the sccache daemon has stopped.

Persistent compiler-cache writes are limited to pushes on the repository's default branch and explicit workflow_dispatch runs. Pull requests may restore the default-branch cache but do not create merge-ref-specific compiler snapshots, so normal PR traffic cannot multiply large archives or require a PR-close cache janitor. GitHub's native retention and quota eviction remain the only archive cleanup policy.

The public compiler cache defaults to 6144 MiB (6 GiB) and can be changed with `sccache-cache-size-mib`. The workflow separately keeps one small immutable `actions/cache` entry for the released `sccache` helper binary so an identical tool does not need to be downloaded on every job.

This deliberately does **not** use sccache's native GHA object backend: that backend maps compiler objects to individual GitHub cache writes and hit upload throttling in a real build. There is also no rolling L0 snapshot, delta artifact, merger workflow, Garage promotion, tailnet access, CI credential broker, Cargo wrapper, or cross-run path-canonicalization layer.

### Private repositories

Private repositories run on the trusted self-hosted runner labelled `local-ci` by default and use the runner's existing system sccache daemon directly. They do not download the GitHub-hosted helper binary and do not restore or save compiler caches with `actions/cache`.

The default system client is `/usr/local/libexec/sccache-client` and the existing daemon is expected on port `4228`. The workflow sets `SCCACHE_START_SERVER=0`, so a missing daemon fails closed instead of silently starting an isolated cache. `private-runner`, `private-sccache-client`, and `private-sccache-server-port` can override those defaults when needed.

The caller still controls the Rust toolchain, components, targets, `RUSTFLAGS`, timeout, and command. Public callers may also choose the hosted runner label and public cache-size bound. Cargo writes build outputs to a runner-local target directory in both modes.

## Cargo release-age quarantine

`.github/workflows/cargo-release-quarantine.yml` rejects crates.io package versions newly introduced by a pull request until they are at least 72 hours old by default. The caller keeps only a tiny trigger workflow; the implementation lives here and is checked out at the exact reusable-workflow SHA via `job.workflow_sha`.

The underlying `.github/actions/cargo-release-quarantine` composite also supports non-failing eligibility probes (`fail-on-blocked: "false"`) for automation that needs to wait for a frozen lockfile snapshot to age without modifying it.
