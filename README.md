# ci-workflows

Centrally managed reusable GitHub Actions workflows for `codeandsolder` repositories.

## Rust GitHub Actions sccache

`.github/workflows/rust-sccache.yml` runs a caller-supplied Rust command on a GitHub-hosted runner using the maintained `codeandsolder/sccache-deduplicated` client.

Compiler outputs live in a bounded local sccache directory and are persisted between compatible GitHub-hosted jobs with ordinary `actions/cache`. The primary cache key is immutable and derived from the runner image label and platform, Rust toolchain, `RUSTFLAGS`, sccache release, cache-size policy, and tracked Cargo manifests/lockfiles. When the Cargo graph changes, the workflow restores the newest semantically compatible snapshot and saves one new graph-specific snapshot after the sccache daemon has stopped.

Persistent compiler-cache writes are limited to pushes on the repository's default branch and explicit workflow_dispatch runs. Pull requests may restore the default-branch cache but do not create merge-ref-specific compiler snapshots, so normal PR traffic cannot multiply 1 GiB archives or require a PR-close cache janitor. GitHub's native retention and quota eviction remain the only archive cleanup policy.

This deliberately does **not** use sccache's native GHA object backend: that backend maps compiler objects to individual GitHub cache writes and hit upload throttling in a real build. There is also no rolling L0 snapshot, delta artifact, merger workflow, Garage promotion, tailnet access, CI credential broker, Cargo wrapper, or cross-run path-canonicalization layer.

The compiler cache defaults to 1024 MiB and can be changed with `sccache-cache-size-mib`. The workflow separately keeps one small immutable `actions/cache` entry for the released `sccache` helper binary so an identical tool does not need to be downloaded on every job.

The caller controls the Rust toolchain, components, targets, `RUSTFLAGS`, runner label, timeout, cache-size bound, and command. Cargo uses the stock toolchain client and writes build outputs to a runner-local target directory.
