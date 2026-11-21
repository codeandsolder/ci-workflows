# ci-workflows

## Two-tier Rust CI and stale-run cancellation

The standard lane uses `rust-sccache.yml` with the current project Rust toolchain (default `1.99.1`) and Linux (`ubuntu-24.04` for public repos, an existing `local-ci` host-managed Linux x64 runner for private repos) on every PR and default-branch push.

The default `rustflags: auto` sets `-C target-cpu=x86-64-v2` only on X64 runners; other architectures get no CPU override. Explicit `rustflags` are passed through unchanged. Cross-compilation from an X64 runner to another architecture must explicitly set `rustflags: ""` or its own target-appropriate flags. sccache keys use the resolved effective flags, not the `auto` placeholder.

Additional MSRV, older/newer toolchain, alternative OS/architecture, sanitizer and compatibility lanes are optional **release-tier** jobs. Call the same reusable workflow with `validation-tier: release`. These jobs are skipped unless the caller is running on a release tag (`refs/tags/*`). For example, the caller may define separate jobs invoking this workflow with distinct `rust-toolchain`, `runner` and `rust-targets` inputs. A release tag must be included in the caller's `on.push.tags` trigger (and not excluded by other conditions); `workflow_dispatch` is not a release trigger.

## Enforced PR workflow supersession policy

GitHub does **not** inherit workflow-level concurrency from a reusable workflow.
Every workflow with actionable pull-request triggers must declare its own
workflow-level group, scoped to the PR and ideally to the workflow/event type.
This configuration is **verified centrally** rather than reimplemented as
repository-specific tests: the canonical checker and its composite Action live
in [.github/actions/workflow-concurrency-policy](.github/actions/workflow-concurrency-policy/).
It checks *every* YAML workflow in the caller repository, including
non-Rust tasks, and rejects missing/disabled cancellation, PR-key collisions,
invalid PR-target group identity and unsafe mixed-event groups. Pure
PR-close cleanup, workflow_call-only, release-only and non-PR workflows
do not require PR supersession. Test fixtures and the provider's own hosted
check are in .github/scripts/test-workflow-concurrency.py and
.github/workflows/workflow-concurrency-policy.yml.

A workflow whose every invocation recomputes a *global snapshot* (for
example, all open pull-request conflict labels) deliberately uses one
`${{ github.workflow }}` group with unconditional cancellation: the latest
run supersedes all earlier writes, including runs initiated by another PR
or a default-branch push. To express this exceptional but valid semantic,
add a root-level source comment with an explicit rationale:

~~~yaml
# ci-workflow-supersession: global-snapshot; every run recalculates all open PR states
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: true
~~~

The checker accepts this mode only with a documented rationale and that
exact last-run-wins group. Ordinary PR validation must still use PR-keyed
groups; never use global cancellation for independent PR builds.

The rust-skills2 strict CI calls the same pinned action during its regular
validation, so projects already consuming the shared strict gate acquire
enforcement without a separate per-repository check. Non-Rust projects can call
the provider's reusable validation workflow. Its `runner: auto` default
uses the registered `local-ci` runner for private callers and hosted Ubuntu
for public callers. Static-only private repositories without registered
`local-ci` runners may explicitly request a GitHub-hosted runner with
`runner: '"ubuntu-24.04"'` and do not need host/runner provisioning merely
to lint workflow YAML. This is enforcement of native GitHub Actions
cancellation, not a custom polling daemon.

The concurrency checker uses the provider's committed `.github/uv.lock`,
including when its reusable workflow checks out only the required action
and lock files. Consumers do not duplicate Python package versions for this
check.

Example validated workflow group (this declaration is necessarily local,
because GitHub requires concurrency at the *caller* workflow level):

~~~yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
~~~

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
| Stable 1.x+ minor/patch/pin/digest | PR automerge after green checks, after the applicable release-age check; compatible Cargo minor/patch updates are grouped |
| Pre-1.0 patch | PR automerge after green checks and applicable release-age check |
| Rust toolchain (stable and nightly) | PR for review; do not silently change pinned compiler versions or project MSRV |
| Pre-1.0 minor, major, replacement | PR for review |
| Third-party GitHub Actions digest/pinning | PR automerge after green checks |
| `codeandsolder/ci-workflows` and `rust-skills2` SHA updates | Grouped; PR automerge after consumer CI succeeds |
| Lockfile maintenance | Weekly, PR automerge after green checks including newly introduced external crates.io versions |

When a workflow uses one pinned Rust nightly for several steps (such as cache identity, `dtolnay/rust-toolchain` and `cargo +...`), declare `RUST_NIGHTLY_TOOLCHAIN: nightly-YYYY-MM-DD` once in the workflow `env`. Reference `${{ env.RUST_NIGHTLY_TOOLCHAIN }}` in action inputs and `"$RUST_NIGHTLY_TOOLCHAIN"` in shell commands. The fleet Renovate regex manager tracks that env declaration as the same review-only `rust`/`rust-version` dependency as explicit `rust-toolchain:` inputs; it prevents drift between the cache key, installed compiler and executed compiler.

Use immutable SHA references to shared workflows and actions with a tracking `# main` suffix:

```yaml
uses: codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@<full-sha> # main
```

`platformAutomerge: false` and `ignoreTests: false` deliberately require Renovate itself to observe passing branch checks; this matters for repositories without GitHub required-check protection. A repository without checks **does not automatically merge**. The final source-based Renovate rule requires a 72-hour release age for Cargo registry crate releases. First-party Git dependencies and pinned shared CI SHAs do not incur a release-age delay. The independent Cargo lockfile gate checks newly introduced registry versions, including transitive dependencies, in every consuming repository regardless of its owner. A registry crate is not first-party merely because its metadata claims a codeandsolder repository; registry exceptions would require independently verified ownership. Other dependency ecosystems retain their existing no-age defaults. Ordinary failed, pending, or unknown CI checks still block automerge.

### Keep routine dependency maintenance from flooding CI

The fleet allows at most one newly created Renovate PR and one automated Renovate branch commit per repository per hour (`prHourlyLimit: 1`, `commitHourlyLimit: 1`). The commit limit covers creation **and automatic rebases**, which both start CI. The six-open-PR ceiling leaves room for review-only major/toolchain updates; it is not a runner-concurrency limit. Use `rebaseWhen: auto` so automerging and up-to-date-required PRs keep their necessary rebase checks, but review-only PRs otherwise rebase on conflict rather than every main-branch commit. Deliberate manual rebase requests and vulnerability-alert fixes retain Renovate's native priority exceptions. This is ingress throttling, not an Actions job priority or a fleet-global cap. Do not add a release-age delay or skip correctness checks.

Central changes do **not** override project-specific `packageRules` applied later. Remove old local `automerge: false` GitHub Actions and first-party trust-root copies when migrating. Changes to the shared CI's callable workflow inputs may break consumers; those PR checks must be repaired, not bypassed. Do not manually merge ordinary green PRs seconds after they appear: Renovate merges on later runs and insists that the head be up-to-date.

These rules standardize execution by repository visibility, not by a host's name or incompatible repository-specific runner labels. They do not force a common compiler/target choice or release artifact across project boundaries. The reusable `rust-sccache.yml` and shared setup/finalize actions implement those common mechanisms; callers provide the commands and target matrix needed by their own products.

The Cargo release-age quarantine's `runner` input defaults to `auto`:
public repositories use `ubuntu-24.04`, private repositories use the same
registered `local-ci` pool as the shared Rust and strict workflows. Specialized
callers may still supply an explicit JSON-encoded runner selector.



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

Public repositories run on the requested GitHub-hosted runner using the pinned `mozilla-actions/sccache-action` installer with sccache v0.19.0. The hosted job starts a runner-local daemon; it never reaches the private Garage service.

Compiler outputs live in a bounded local sccache directory and are persisted between compatible GitHub-hosted jobs with ordinary `actions/cache`. A v3 key partitions by runner platform/image, actual compiler identity plus requested toolchain, effective flags, sccache version and cache size, then workload and Cargo graph. Every workflow run/attempt gets its own generation. Restoration prefers the same workload and graph, then the same workload, then a compatible compiler snapshot. This allows a trusted build with misses to publish refreshed compiler objects instead of permanently reusing a stale exact graph key. The reusable workflow derives scope from its command and target set; direct callers use workflow/job identity by default. Set an explicit scope for cooperating jobs (such as the smoke prime and restore). For side-by-side repository checkouts set `repository-path` to the primary checkout; the Cargo graph is derived from that Git root. The effective compiler identity respects an explicitly configured `RUSTC`, then the installed requested rustup toolchain (including Cargo +toolchain callers), then the current rustc. Install the selected toolchain before cache setup.

Persistent compiler-cache writes are limited to pushes and scheduled runs on the repository's default branch and explicit workflow_dispatch runs, only when compiler misses were observed and the generation is not already present. Pull requests may restore the default-branch cache but do not create merge-ref-specific compiler snapshots, so normal PR traffic cannot multiply large archives or require a PR-close cache janitor. GitHub's native retention and quota eviction remain the only archive cleanup policy.

The public compiler cache defaults to 6144 MiB (6 GiB) and can be changed with `sccache-cache-size-mib`. The workflow separately keeps one small immutable `actions/cache` entry for the released `sccache` helper binary so an identical tool does not need to be downloaded on every job.

This deliberately does **not** use sccache's native GHA object backend: that backend maps compiler objects to individual GitHub cache writes and hit upload throttling in a real build. There is also no rolling L0 snapshot, delta artifact, merger workflow, Garage promotion, tailnet access, CI credential broker, Cargo wrapper, or cross-run path-canonicalization layer.

### Public cross-rs containers

Set `execution: cross` on the setup action (or `cache-execution: cross` on the reusable workflow) for Linux x64 hosted cross-rs Docker builds. The static client and local cache directory are bind-mounted; the shared entrypoint starts/stops sccache **inside** each build container and records stats outside its cache directory. The normal finalizer verifies actual compiler requests and persists the same native GitHub cache archive. A separate semantic namespace prevents restoring incompatible host-native snapshots. Use explicit workload scope for each target. This mode is not available on private runners: private builds must keep using the managed daemon. The cross image must use the standard command-only entrypoint contract.

### Private repositories

Private repositories automatically select a registered self-hosted Linux x64 runner using the built-in GitHub labels `[self-hosted, Linux, X64, local-ci]`. The `local-ci` capability label explicitly identifies a host-managed runner with Rustup and a compatible Garage-backed sccache endpoint; it avoids accidentally scheduling on legacy containerized registrations whose separate filesystem cannot expose compiler executables to the host-side sccache daemon. The caller's `runner` input is **public-only**, so private repositories cannot accidentally be dispatched to GitHub-hosted runners. GitHub schedules an eligible existing local runner (Acer or Asus); the shared workflow does not assume a machine name such as `acer`/`asus`, or legacy labels such as `codeandsolder-private`. The logical `local-ci` pool is required.

A runner registration remains **repository-scoped** in our current deployment. The repository must have an online registered local runner to execute private jobs; changing a workflow cannot create registrations on another machine. The root-managed `/srv/ci/github-actions/bin/register-repo-runner` on the existing hosts is the standard provisioning mechanism; it defaults to the optional `local-ci` label. Do not add per-repository physical machines.

Private builds use the existing managed sccache backend (Garage) and never create their own sccache daemon or an Actions-backed compiler-cache snapshot. When `/usr/local/libexec/sccache-client` exists, the workflow calls that canonical host wrapper **without overriding its managed UDS/TCP selection**. It is already configured for the correct daemon on Acer and Asus. For containerized runners with a mounted `/run/host-sccache/sccache.sock` and matching `/usr/local/bin/sccache` client, the workflow uses the mounted socket instead. The client must be compatible with the host daemon; otherwise the job fails rather than silently falling back or spawning a second cache. Both use `SCCACHE_START_SERVER=0` and `SCCACHE_NO_AUTO_START_SERVER=1`, and the finalizer requires backend error counters not to increase.

The caller still controls toolchain, components, targets, `RUSTFLAGS`, timeout, command, and validation tier. Public callers may choose the GitHub-hosted runner label and Actions cache size. Private executor selection and compiler-cache backend are centralized. Existing direct-workflow jobs that hardcode `asus` must migrate to these shared workflows or update their own `runs-on` labels; a shared workflow cannot rewrite a separate caller's direct jobs.

### Test suites that manage sccache daemons

`isolate-public-sccache-server: true` places the hosted Linux/macOS compiler-cache daemon on a dedicated Unix-domain socket, distinct from the default TCP endpoint used by the program's integration tests. This is designed for repositories such as `sccache-deduplicated` whose tests deliberately start/stop their own sccache instance. The compiler and finalizer retain the dedicated socket; the caller should launch **only the test executables** with `SCCACHE_SERVER_UDS` unset using Cargo's target runner, preserving the compiler's mandatory cache. This option is public-Unix only and explicitly rejects Windows instead of silently failing to isolate. Do not use it on a private local/Garage runner; the root-managed daemon there remains unchanged.

## Cargo release-age quarantine

The shared `.github/workflows/cargo-release-quarantine.yml` rejects newly introduced crates.io package versions under 72 hours old. Standard strict Rust CI invokes the same action for all repository owners; first-party Git-sourced dependencies are outside the registry check, but their newly introduced external transitive crates remain subject to it. The caller keeps only a tiny trigger workflow; the implementation lives here and is checked out at the exact reusable-workflow SHA via `job.workflow_sha`. The reusable action `.github/actions/cargo-release-quarantine` can also be invoked directly from a different shared CI gate, without adding another checkout to the caller's source workspace.

By default, `lockfile: auto` scans **all git-tracked `Cargo.lock` files**, including nested independent Rust workspaces. It compares the union of crates.io package identities across all lockfiles in the PR checkout with the union in the base commit, so shared versions are looked up once and moving a lockfile does not produce a spurious introduction. A newly introduced crate version is blocked until its crates.io publication is at least 72 hours old; metadata lookup failures fail closed. Removing a lockfile while the same workspace's Cargo.toml remains is rejected, but deleting an entire workspace is valid. Repositories without any tracked Cargo.lock have nothing for this lockfile-based gate to inspect.

Use `lockfile: path/to/Cargo.lock` only when a *single* explicit lockfile is desired, for example a synthetic CI fixture. Standard Rust CI should use the `auto` default. The action also supports `fail-on-blocked: "false"` when a maintenance process wants to probe eligibility without making CI red. The checker discovers tracked paths via Git, not untracked `target` or CI checkout folders; no code from lockfiles is executed. For private caller repositories, check out the PR merge ref with `fetch-depth: 2` before invoking the direct action: the exact PR base commit will already exist locally, so no network fetch (and no retained Git authentication) is required. The action verifies the SHA exists locally before attempting a fallback fetch; if GitHub did not supply that commit, a failed fetch is a hard CI failure, not a quarantine bypass.

The underlying `.github/actions/cargo-release-quarantine` composite also supports non-failing eligibility probes (`fail-on-blocked: "false"`) for automation that needs to wait for a frozen lockfile snapshot to age without modifying it.

## Duplicate-code regression gate

The mandatory reusable `.github/workflows/clone-regression.yml` has **no
caller-adjustable thresholds, language filters, scan roots, or exclusion globs**.
It discovers at 50 tokens, blocks production/mixed groups at 100 tokens and
test-only groups at 140 tokens. The scanner always runs with `--no-config`;
only reviewed `.doppelscan.toml` fingerprint accepts with meaningful reasons
are honored. For exploratory custom scans, invoke the composite
`.github/actions/clone-regression` in an explicitly advisory job, separate
from the mandatory gate. This prevents routine callers from weakening the
central regression contract via workflow inputs.


Use the pinned reusable [clone-regression.yml](.github/workflows/clone-regression.yml)
on pull requests and default-branch pushes. It runs `doppelscan` **v0.9.0**
against the Git base, discovers new clones at **50 syntax tokens**, and applies
different blocking thresholds to **production (100)** and **test-only (140)**
code. All advisory findings remain in the JSON artifact. Existing clone groups
in the Git base are grandfathered in; a benign edit or file move does not fail.
The scanner matches normalized syntax, not just literal text.

A consumer workflow can be as small as:

```yaml
name: Duplicate-code regression
on:
  pull_request:
  push:
    branches: [main] # adapt to the repository's default branch

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

permissions:
  contents: read

jobs:
  duplicates:
    uses: codeandsolder/ci-workflows/.github/workflows/clone-regression.yml@<full-commit-sha> # main
```

### Test classification

Clone groups get the larger threshold **only when every occurrence is in test
code**. Dedicated test files and `smoke-*.sh` fixtures count as tests, as do
regions of Rust source inside `#[cfg(test)] mod ...` or directly annotated
`#[test]` functions. Rust test ranges are matched by syntax-aware brace
tracking that ignores nested comments, raw strings, ordinary string literals,
and character literals; code after a test module is production. Any mixed
production/test clone remains **production**. Missing, unreadable, or ambiguous
source is classified as production, not silently exempted.

By default, dedicated `tests/`, `examples/`, `benches/`, `vendor/`,
`node_modules/`, and `target/` directories, plus the injected shared-CI checkout,
are excluded to avoid noise. Inline Rust unit tests remain scanned and reported.
Caller-specific paths can still be excluded with the newline-separated
`exclude-globs` input, but this suppresses both discovery and blocking.

### Reviewed fingerprint exceptions

For intentional duplication that **should be retained**, place a documented
fingerprint in the *caller repository root's* `.doppelscan.toml`:

```toml
[[accept]]
fingerprint = "b4a94232d76e"
reason = "Independent physical oracles must not share the implementation being checked."
```

Every accepted fingerprint needs a meaningful reason. The full finding remains
in `doppelscan-report.json` under `accepted` with that reason; it does not
block CI. A changed clone fingerprint requires a fresh review. Only
`[[accept]]` declarations are consumed: the central gate still runs the pinned
scanner with `--no-config`. Settings such as `exclude`, `min-tokens`, `strict`,
and `[check]` in the caller's config **cannot weaken the centralized policy**.

### Operation and verification

The gate fetches the PR base SHA (or `push.before`) without full history, using
`ubuntu-24.04` for public repositories or existing `local-ci` Linux X64 runners
for private ones. Its scanner is downloaded as a SHA256-verified pinned release
into the job's temporary directory. No Rust compiler cache is involved. The
policy classifier requires Python 3.11+ and only its standard library.

Workflow inputs default to `discovery-tokens: 50`, `blocking-tokens: 100`
(production), `test-blocking-tokens: 140`, `languages: ""`, and
`scan-path: "."`. They can be adjusted centrally or explicitly by the caller.
Malformed thresholds, missing Git bases, malformed acceptance entries, and
source files escaping the scan root fail closed. An all-zero first-push baseline
is unsupported by this differential check; `merge_group` is supported.

The [clone-regression-smoke.yml](.github/workflows/clone-regression-smoke.yml)
provider workflow tests the real binary and Git history, including exact and
renamed clones, accepted changes, moves, test-only advisory findings, production
copies inside tests, larger test clones, malformed configuration, and reviewed
fingerprint accepts. The policy module has additional lexer and classification
unit tests.
