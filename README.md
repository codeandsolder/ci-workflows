# ci-workflows

## Two-tier Rust CI and stale-run cancellation

The standard lane uses `rust-sccache.yml` with the current project Rust toolchain (default `1.99.1`) and Linux (`ubuntu-24.04` for public repos, the existing Asus Linux runner for private repos) on every PR and default-branch push.

The default `rustflags: auto` sets `-C target-cpu=x86-64-v2` only on X64 runners; other architectures get no CPU override. Explicit `rustflags` are passed through unchanged. Cross-compilation from an X64 runner to another architecture must explicitly set `rustflags: ""` or its own target-appropriate flags. sccache keys use the resolved effective flags, not the `auto` placeholder.

Additional MSRV, older/newer toolchain, alternative OS/architecture, sanitizer and compatibility lanes are optional **release-tier** jobs. Call the same reusable workflow with `validation-tier: release`. These jobs are skipped unless the caller is running on a release tag (`refs/tags/*`). For example, the caller may define separate jobs invoking this workflow with distinct `rust-toolchain`, `runner` and `rust-targets` inputs. A release tag must be included in the caller's `on.push.tags` trigger (and not excluded by other conditions); `workflow_dispatch` is not a release trigger.

**Cancel obsolete PR runs in the caller**. GitHub does not let a reusable workflow set the caller's workflow-level concurrency, and using `github.workflow` at both levels risks a called job canceling its own caller. Every consumer workflow should include:

```yaml
concurrency:
  group: ci-${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

This cancels the prior revision of the **same** PR and workflow, without canceling another workflow, release-tag run, schedule or merge-group verification. Do not add a second conflicting concurrency group inside the reusable workflow. Pinned old workflows and their existing runs are not retroactively canceled when callers update.

## Renovate: keep shared CI up to date without the dependency-age wait

Each consumer should extend `github>codeandsolder/ci-workflows:renovate-ci-trust-root` in `renovate.json`, and reference shared workflows with immutable SHA plus `# main` so Renovate can track upstream main:

```yaml
uses: codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@<full-sha> # main
```

The preset exempts only the trusted `codeandsolder/ci-workflows` and `codeandsolder/rust-skills2` GitHub Actions references from `minimumReleaseAge`. It leaves ordinary Cargo dependencies in quarantine and keeps CI trust-root updates reviewable (`automerge: false`). Broad local GitHub Actions grouping rules should exclude these two dependencies or be ordered before the specific trust-root rule, otherwise an unrelated young action can hold back a grouped shared-CI update.

The Cargo release-age quarantine already checks only **new crates.io versions in Cargo.lock**, not GitHub Actions SHAs. A CI-only PR must pass with zero new crates; a mixed PR introducing young crates must still fail. Consumer quarantine workflows should trigger for all PRs rather than path-filtering `Cargo.lock` if the check is branch-protection-required, so a CI-only PR gets an explicit pass instead of an indefinitely expected status.

Centrally managed reusable GitHub Actions workflows for `codeandsolder` repositories.

## Renovate-tracked reusable workflow pins

Consumers should call reusable workflows with an immutable full commit SHA plus the tracked branch comment, for example `@<full-commit-sha> # main`. Renovate's GitHub Actions manager can then advance the SHA as `main` moves while every individual CI run still executes immutable code. Bare SHAs are intentionally avoided because they do not tell Renovate which branch or tag to follow; floating `@main` is avoided because the executed workflow can change without a caller commit.

The repository Renovate configuration already enables GitHub Actions dependency management and digest pinning, so the same convention is used for this repository's own `rust-skills2` reusable-workflow dependency.

## Rust sccache policy

`.github/workflows/rust-sccache.yml` chooses the execution/cache path from the caller repository visibility.

### Public repositories

Public repositories run on the requested GitHub-hosted runner using the pinned `mozilla-actions/sccache-action` installer with sccache v0.18.0. The hosted job starts a runner-local daemon; it never reaches the private Garage service.

Compiler outputs live in a bounded local sccache directory and are persisted between compatible GitHub-hosted jobs with ordinary `actions/cache`. The primary cache key is immutable and derived from the runner image label and platform, Rust toolchain, `RUSTFLAGS`, sccache release, cache-size policy, and tracked Cargo manifests/lockfiles. When the Cargo graph changes, the workflow restores the newest semantically compatible snapshot and saves one new graph-specific snapshot after the sccache daemon has stopped.

Persistent compiler-cache writes are limited to pushes on the repository's default branch and explicit workflow_dispatch runs. Pull requests may restore the default-branch cache but do not create merge-ref-specific compiler snapshots, so normal PR traffic cannot multiply large archives or require a PR-close cache janitor. GitHub's native retention and quota eviction remain the only archive cleanup policy.

The public compiler cache defaults to 6144 MiB (6 GiB) and can be changed with `sccache-cache-size-mib`. The workflow separately keeps one small immutable `actions/cache` entry for the released `sccache` helper binary so an identical tool does not need to be downloaded on every job.

This deliberately does **not** use sccache's native GHA object backend: that backend maps compiler objects to individual GitHub cache writes and hit upload throttling in a real build. There is also no rolling L0 snapshot, delta artifact, merger workflow, Garage promotion, tailnet access, CI credential broker, Cargo wrapper, or cross-run path-canonicalization layer.

### Private repositories

Private repositories run on the trusted self-hosted Asus runner labelled `asus`; the provider selects it from the caller repository's visibility and verifies `RUNNER_NAME` contains `asus`. They use the runner's existing system sccache daemon directly. They do not download the GitHub-hosted helper binary and do not restore or save compiler caches with `actions/cache`.

The mandatory system client is `/usr/local/libexec/sccache-client` and the existing daemon is expected on port `4228`. The workflow sets `SCCACHE_START_SERVER=0`, so a missing daemon fails closed instead of silently starting an isolated cache. These infrastructure settings are deliberately not configurable through reusable-workflow inputs.

The caller still controls the Rust toolchain, components, targets, `RUSTFLAGS`, timeout, command and validation tier. Public callers may also choose the hosted runner label and public cache-size bound. The private runner and cache backend cannot be overridden by the caller. Cargo writes build outputs to a runner-local target directory in both modes.

## Cargo release-age quarantine

`.github/workflows/cargo-release-quarantine.yml` rejects crates.io package versions newly introduced by a pull request until they are at least 72 hours old by default. The caller keeps only a tiny trigger workflow; the implementation lives here and is checked out at the exact reusable-workflow SHA via `job.workflow_sha`.

The underlying `.github/actions/cargo-release-quarantine` composite also supports non-failing eligibility probes (`fail-on-blocked: "false"`) for automation that needs to wait for a frozen lockfile snapshot to age without modifying it.
