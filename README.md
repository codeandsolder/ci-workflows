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

## Renovate: one fleet policy, small consumer exceptions

Consumers extend `github>codeandsolder/ci-workflows:renovate-fleet` in `renovate.json`. Keep only project-specific constraints there (e.g. pinned ABI/toolchain floors, incompatible dependency pairs, genuinely exceptional grouping). The shared preset includes `config:recommended`, pinned GitHub Actions, the [first-party CI trust-root preset](renovate-ci-trust-root.json), and the common update lifecycle.

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>codeandsolder/ci-workflows:renovate-fleet"]
}
```

| Update | Central behavior |
| --- | --- |
| Stable 1.x+ minor/patch/pin/digest | PR automerge after green checks and three-day release age; compatible Cargo minor/patch updates are grouped |
| Pre-1.0 patch | PR automerge after green checks and three-day release age |
| Pre-1.0 minor, major, replacement | PR for review |
| Third-party GitHub Actions digest/pinning | PR automerge after age-gated green checks |
| `codeandsolder/ci-workflows` and `rust-skills2` SHA updates | Grouped, exempt from the package-age hold; PR automerge after consumer CI succeeds |
| Lockfile maintenance | Weekly, PR automerge only after checks and any configured release-age quarantine clear |

Use immutable SHA references to shared workflows and actions with a tracking `# main` suffix:

```yaml
uses: codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@<full-sha> # main
```

`platformAutomerge: false` and `ignoreTests: false` deliberately require Renovate itself to observe passing branch checks; this matters for repositories without GitHub required-check protection. A repository without checks **does not automatically merge**. The central age gate and the independent [Cargo release-age quarantine](.github/workflows/cargo-release-quarantine.yml) are complementary: newly introduced crates may not bypass either; the quarantine still blocks for 72 hours. Unrelated failed, pending, or unknown checks also block automerge.

Central changes do **not** override project-specific `packageRules` applied later. Remove old local `automerge: false` GitHub Actions and first-party trust-root copies when migrating. Changes to the shared CI's callable workflow inputs may break consumers; those PR checks must be repaired, not bypassed. Do not manually merge ordinary green PRs seconds after they appear: Renovate merges on later runs and insists that the head be up-to-date.

These rules intentionally do not force common runner labels, compiler/target choices, or release artifacts across project boundaries. The reusable `rust-sccache.yml`, shared setup/finalize actions, and Cargo quarantine implement those common mechanisms; callers provide the commands and target matrix needed by their own products.



### Validating Renovate-only changes without rebuilding the product

The reusable [`renovate-config.yml`](.github/workflows/renovate-config.yml) uses the official, version-pinned Renovate CLI to validate the caller's root `renovate.json`. A consumer can give Renovate-only pull requests one genuine, inexpensive config test:

```yaml
name: Renovate configuration
on:
  pull_request:
    paths: [renovate.json]
permissions:
  contents: read
jobs:
  validate:
    uses: codeandsolder/ci-workflows/.github/workflows/renovate-config.yml@<full-sha> # main
```

The root config is the only file expected by this contract. Keep the normal product build, lint, test, cross-platform and release gates for PRs that change source, Cargo manifests/lockfiles, CI workflows or release configuration. For workflows without required check names, `pull_request.paths-ignore: [renovate.json]` can avoid launching an expensive product matrix on an exclusively config-only PR; any other modified file still causes it to run. If a required GitHub check would be skipped and left pending, use a job-level detection/skip strategy instead of filtering away that required workflow. Never use an empty JSON syntax check as a substitute for the actual Renovate validator.

The provider's own [`sccache-smoke.yml`](.github/workflows/sccache-smoke.yml) runs its full Linux/ARM/macOS/Windows matrix only when shared sccache implementation, smoke fixtures, or the smoke workflow itself change; manual dispatch remains available. Renovate preset edits run the dedicated policy-invariants and upstream validator checks, without exercising unrelated cache platforms.


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

### Test suites that manage sccache daemons

`isolate-public-sccache-server: true` places the hosted Linux/macOS compiler-cache daemon on a dedicated Unix-domain socket, distinct from the default TCP endpoint used by the program's integration tests. This is designed for repositories such as `sccache-deduplicated` whose tests deliberately start/stop their own sccache instance. The compiler and finalizer retain the dedicated socket; the caller should launch **only the test executables** with `SCCACHE_SERVER_UDS` unset using Cargo's target runner, preserving the compiler's mandatory cache. This option is public-Unix only and explicitly rejects Windows instead of silently failing to isolate. Do not use it on the private Asus/Garage runner; the root-managed daemon there remains unchanged.

## Cargo release-age quarantine

`.github/workflows/cargo-release-quarantine.yml` rejects crates.io package versions newly introduced by a pull request until they are at least 72 hours old by default. The caller keeps only a tiny trigger workflow; the implementation lives here and is checked out at the exact reusable-workflow SHA via `job.workflow_sha`. The reusable action `.github/actions/cargo-release-quarantine` can also be invoked directly from a different shared CI gate, without adding another checkout to the caller's source workspace.

By default, `lockfile: auto` scans **all git-tracked `Cargo.lock` files**, including nested independent Rust workspaces. It compares the union of crates.io package identities across all lockfiles in the PR checkout with the union in the base commit, so shared versions are looked up once and moving a lockfile does not produce a spurious introduction. A newly introduced crate version is blocked until its crates.io publication is at least 72 hours old; metadata lookup failures fail closed. Removing a lockfile while the same workspace's Cargo.toml remains is rejected, but deleting an entire workspace is valid. Repositories without any tracked Cargo.lock have nothing for this lockfile-based gate to inspect; they still remain subject to Renovate's separately configured package-age policy.

Use `lockfile: path/to/Cargo.lock` only when a *single* explicit lockfile is desired, for example a synthetic CI fixture. Standard Rust CI should use the `auto` default. The action also supports `fail-on-blocked: "false"` when a maintenance process wants to probe eligibility without making CI red. The checker discovers tracked paths via Git, not untracked `target` or CI checkout folders; no code from lockfiles is executed. For private caller repositories, check out the PR merge ref with `fetch-depth: 2` before invoking the direct action: the exact PR base commit will already exist locally, so no network fetch (and no retained Git authentication) is required. The action verifies the SHA exists locally before attempting a fallback fetch; if GitHub did not supply that commit, a failed fetch is a hard CI failure, not a quarantine bypass.

The underlying `.github/actions/cargo-release-quarantine` composite also supports non-failing eligibility probes (`fail-on-blocked: "false"`) for automation that needs to wait for a frozen lockfile snapshot to age without modifying it.
