# ci-workflows

## Language-specific quality modules

The shared CI keeps language-neutral orchestration separate from language
quality checks. [Tracked-source detection](languages/detect.mjs) reads the
caller's Git index (not the injected CI checkout) and reports which languages
actually occur. Modules live under `languages/<language>/`; Rust's existing
`rust-sccache.yml`, `rust-coverage.yml` and strict Rust workflows remain
independent and retain their established consumer interfaces.

### Java: automatic PMD gate

The [reusable Java quality workflow](.github/workflows/java-quality.yml)
checks for **any Git-tracked `.java` source anywhere in the caller repo**,
including scripts and mixed-language repositories. It only installs Java,
Gradle and runs [PMD 7.29.0](languages/java/quality.xml) when such source
exists. Otherwise it reports an explicit successful no-Java skip. It requires
no Maven/Gradle setup, Java project layout or dependencies in the caller.

~~~yaml
jobs:
  java-quality:
    uses: codeandsolder/ci-workflows/.github/workflows/java-quality.yml@<full-sha> # main
~~~

This is a **strict, blocking, zero-debt** static-analysis gate with **228
rules** from PMD's Best Practices, Error Prone, Performance and Security
categories, plus selected concurrency, design, code-style and documentation
rules. These check resource lifetime, control-flow mistakes, API correctness,
common unsafe patterns, dead code, questionable string/collection operations,
and unnecessary Java constructs. The full-category rule groups exclude a
handful of patterns that are not universally bugs (such as literal protocol
discriminants, null sentinels, allocations in loops, or logger-specific
guarding). The rationale and exact exclusions are in
[the central ruleset](languages/java/quality.xml). All findings are fatal;
there is no per-repository baseline.

PMD diagnostics appear in the job log; failing jobs also upload the complete
HTML/XML PMD reports for seven days. The check uses the same reusable workflow
and job name as before, and only prepares Java tooling when Git-tracked Java
exists. Project-specific compilation with `javac -Werror`, tests and
integration/build prerequisites still run in the caller's native workflow:
arbitrary Java cannot safely be compiled without its real dependencies and
toolchain. The Gradle-based Java module is used only as an independent PMD
runner, not to build the caller's Java project.

Public callers use GitHub-hosted Ubuntu; private callers use the registered
`local-ci` Linux x64 pool, consistently with the existing Rust workflow.
The shared source detector has independent Node regression tests, and
[`java-quality-smoke.yml`](.github/workflows/java-quality-smoke.yml)
executes the actual reusable analyzer on the provider's clean Java fixture.

For additional languages, add an isolated quality module and corresponding
reusable workflow alongside Java; do not insert language-specific checks into
the Rust compiler/cache workflow. Keep required check identities stable even
on a no-source skip.

## Conditional shell, JavaScript, WGSL and Actions quality

The source-only reusable workflow (.github/workflows/source-quality.yml) now discovers tracked source and conditionally runs ShellCheck, shfmt syntax checking, Oxlint correctness and headless Naga WGSL validation, all in one Linux runner. Rust-first repositories already using strict Ruff/ty must not duplicate that check; Python-first repositories can opt in to the same pinned action. Shell formatting is opt-in until consumer formatting debt is resolved. The existing reusable workflow-concurrency policy also runs pinned actionlint in its own existing runner. The language modules README has the consumer invocation contract, source-composition rules and version pins.

## Two-tier Rust CI and stale-run cancellation

The standard lane uses `rust-sccache.yml` with the repository's fleet-approved dated nightly and Linux (`ubuntu-24.04` for public repos, an existing `local-ci` host-managed Linux x64 runner for private repos) on every PR and default-branch push.

The default `rustflags: auto` sets `-C target-cpu=x86-64-v2` only on X64 runners; other architectures get no CPU override. Explicit `rustflags` are passed through unchanged. Cross-compilation from an X64 runner to another architecture must explicitly set `rustflags: ""` or its own target-appropriate flags. sccache keys use the resolved effective flags, not the `auto` placeholder.

Additional MSRV, older/newer toolchain, alternative OS/architecture, sanitizer and compatibility lanes are optional **release-tier** jobs. Call the same reusable workflow with `validation-tier: release`. These jobs are skipped unless the caller is running on a release tag (`refs/tags/*`). For example, the caller may define separate jobs invoking this workflow with distinct `rust-toolchain`, `runner` and `rust-targets` inputs. A release tag must be included in the caller's `on.push.tags` trigger (and not excluded by other conditions); `workflow_dispatch` is not a release trigger.

## Informational Rust dependency quality

The shared [`.github/actions/rust-dependency-quality`](.github/actions/rust-dependency-quality/action.yml)
composite scans a selected Cargo workspace **without compiling it**. The pinned
`cargo-deny@0.20.2` checks RustSec advisories (including relevant unsound and
unmaintained records) plus yanked dependencies, and `cargo-machete@0.10.1`
reports potentially unused direct dependencies. A commit-addressed, SHA-256
verified prebuilt Linux x86_64 cargo-anoint scanner reports potentially
overlapping providers, duplicate versions, obsolete dependencies and preferred
organization forks. It scans all features and dependency roles across the
platform union once per workspace; verify mutually exclusive configurations
before consolidating. No scanner builds the caller project.

Results are advisory while the fleet's existing debt and scanner false
positives are reviewed: scanner findings are not a merge gate. The
GitHub job summary distinguishes findings from unavailable/incomplete scans;
raw diagnostics and structured results are available in a 14-day public artifact
or the private job log. An unavailable or malformed cargo-anoint scan is
reported independently of cargo-deny and cargo-machete.
The existing 72-hour external registry quarantine stays mandatory and
independent.

Call the composite **after** an existing successful strict Rust gate in the
same job, using the same checkout and toolchain. No extra runner or source
build is necessary. Use `working-directory` for nested workspaces, and avoid
running the scanner again for each feature/target configuration. The provider's
`rust-dependency-quality-smoke.yml` validates all three scanners against an
intentionally unused path dependency and overlapping HTTP provider fixtures.
To update cargo-anoint, run its scanner-release workflow on main, then update
`anoint-release.json` in the action with the source commit and verified binary
SHA-256; the smoke test verifies the actual release download and report. To suppress known `cargo-machete` false positives,
use reasoned `[package.metadata.cargo-machete]` or
`[workspace.metadata.cargo-machete]` `ignored = ["dep"]` entries in the
caller manifest; do not suppress a vulnerability in this shared config.

## Informational Rust test coverage

Use [`.github/workflows/rust-coverage.yml`](.github/workflows/rust-coverage.yml)
as a **separate, advisory** job. It runs `cargo-llvm-cov` with workspace tests,
publishes available line/function/region/branch totals to the GitHub Actions step summary,
and uploads a 14-day artifact containing browsable `html/index.html`, LCOV,
and LLVM JSON coverage data. There is **no minimum coverage percentage**, and
the coverage job is best-effort: incomplete coverage does not prevent a PR merge
or replace the normal strict Rust tests.

~~~yaml
jobs:
  coverage:
    uses: codeandsolder/ci-workflows/.github/workflows/rust-coverage.yml@<full-sha> # main
    with:
      working-directory: .
      cargo-args: --workspace --locked
~~~

The Rust toolchain is resolved from the caller's pinned manifest, like the
normal shared Rust workflow; `rust-toolchain` can override that pin. Private
repositories run on the managed `local-ci` Linux runner pool and public
repositories on `ubuntu-24.04` by default. The coverage workflow reuses the
normal compiler cache setup/finalization (including Garage on private runners)
and selects `--no-rustc-wrapper` to preserve the already configured sccache
wrapper. Its instrumentation uses `llvm-tools-preview` from the matching Rust
toolchain and pinned `cargo-llvm-cov@0.9.2`. The normal code-quality and test
jobs are unchanged and remain mandatory.

`cargo-args` is a space-separated list of Cargo test-selection flags (for
example `--workspace --locked --all-features`); shell quoting within that
string is not supported. Set `working-directory` for nested workspaces. The
report does not instrument doctests by default. Prefer one dedicated coverage
job per workspace rather than adding coverage to every build/Clippy matrix.
The provider's `rust-coverage-smoke.yml` exercises the reusable workflow
against `smoke-cache` on relevant changes.

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
check are the frozen, independently derived 56-case WASI fixtures in
[policy-wasm/concurrency.test.mjs](policy-wasm/concurrency.test.mjs) and
[policy-wasm/fixtures/concurrency.json](policy-wasm/fixtures/concurrency.json),
with a standalone gate at .github/workflows/provider-checks.yml.
No Python runtime is required for workflow cancellation tests.

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

The concurrency checker executes the provider's digest-verified Rust/WASI
module with a thin Node host adapter, including sparse consumer checkouts.
It requires neither a Python runtime nor a Python package lockfile.

Example validated workflow group (this declaration is necessarily local,
because GitHub requires concurrency at the *caller* workflow level):

~~~yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
~~~

## Required merge-gate contract (pilot)

For first-party workflows with conditional job graphs, use one terminal gate
per workflow instead of requiring each conditional job independently. The
shared reusable workflow compares the caller's native dependency results to
an exact declared expectation for every direct prerequisite. Missing jobs,
unexpected jobs, failures, cancellation, malformed evidence and unexpected
skips all fail closed. At least one prerequisite must succeed. No polling,
check API credentials, cross-run result selection or additional builds are
needed; the dependency results belong to the same Actions execution.

~~~yaml
  merge-gate:
    name: CI merge gate
    if: ${{ always() }}
    needs: [scope, strict-rust, tests]
    uses: codeandsolder/ci-workflows/.github/workflows/merge-gate.yml@PINNED_PROVIDER_SHA
    with:
      needs-json: ${{ toJSON(needs) }}
      expected-results: |
        [
          ["scope", "success"],
          ["strict-rust", "${{ needs.scope.outputs.rust == 'true' && 'success' || 'skipped' }}"],
          ["tests", "${{ needs.scope.outputs.rust == 'true' && 'success' || 'skipped' }}"]
        ]
~~~

The terminal job must depend directly on **all** relevant jobs; use the same
reviewed scope decision for both the conditional job and its expected result,
not the observed result to decide whether the job was required. GitHub treats
skipped checks as successful for required-check purposes, so never put a
conditional job directly in a required rule if skipping it is not always
acceptable. Required jobs must not use continue-on-error to hide failures;
advisory coverage or shadow jobs are not mandatory validation. The gate reads
only dependency results; job outputs are not logged by the evaluator and must
not contain secrets. The reusable workflow checks out only its pinned provider
implementation, not candidate source.

For a required context, ensure the caller is triggered on every pull request
and merge_group, without workflow-level path filters; move path decisions to
an always-running scope job. Use distinct gate names for different workflows,
and require every relevant workflow's stable terminal context in the ruleset.
This avoids one global gate polling other runs or accidentally selecting a
stale SHA. A completely cancelled or missing workflow is not a successful
required gate. Review workflow/expectation changes like other CI trust roots;
the runtime contract does not by itself prevent a caller author from removing
its dependencies or weakening expectations.

The provider's path-scoped merge-gate-contract smoke exercises the actual
reusable workflow with a successful scope job and an intentionally skipped
job; it is not a required context. Enable rulesets only after exact context
names and PR/merge-queue behavior are verified in public pilots. Private
callers use registered local-ci runners. Do not apply rules that the private
repository's GitHub plan cannot enforce.

### Enroll verified repositories in native GitHub automerge

Use the shared `renovate-native-automerge` preset as a final extension after
the existing shared fleet preset, only after installing the required CI rules.
It changes the merge transport, not dependency eligibility or release age.
Do not apply it to repositories whose GitHub plan cannot enforce rulesets,
or to upstream-tracking forks until their direct publication path is compatible.

For each repository, review every mandatory PR workflow, including native
tests, quarantine and strict source validation. Establish an unconditional
terminal merge gate for every such workflow, with distinct names, and verify
real PR and default-branch runs before enrollment. Verify merge-group behavior
if a merge queue is used. Do not infer the required gate set from whichever
checks happened to report. Use the full reviewed set of exact context names.

```bash
node scripts/native-renovate-automerge.mjs plan codeandsolder/REPO MERGED_PR \\
  'CI merge gate / Verify expected job results'
node scripts/native-renovate-automerge.mjs apply codeandsolder/REPO MERGED_PR \\
  'CI merge gate / Verify expected job results'
```

The controller verifies successful, unambiguous GitHub Actions results on the
merged validation PR head and the current default-branch SHA. It installs a
dedicated active ruleset, with exact Actions-attributed contexts, strict
up-to-date checks and no bypass actors, without replacing existing rules.
Only after reading back the effective rule does it enable GitHub auto-merge.
Administrative API permission is required. Existing differing rulesets are
rejected rather than overwritten. The default branch must remain unchanged
during planning and application.

After successful enrollment, submit a consumer config PR adding the native
preset as the final extension, and validate that the real Renovate PR remains
open on failed or pending CI and merges on green CI. Keep private Free-plan
repositories and other unenforceable repositories on Renovate-side automerge.
If removing required rules, remove the opt-in and disable native automerge
first; never leave native Renovate automerge without enforced checks.

## Renovate: one fleet policy, small consumer exceptions

Consumers extend `github>codeandsolder/ci-workflows:renovate-fleet` in `renovate.json`. Keep only project-specific constraints there (e.g. pinned ABI/toolchain floors, incompatible dependency pairs, genuinely exceptional grouping). The shared preset includes `config:recommended`, pinned GitHub Actions, the [first-party CI trust-root preset](renovate-ci-trust-root.json), and the common update lifecycle.

For small-patch upstream-tracking forks that leave dependency ownership with
upstream, extend `github>codeandsolder/ci-workflows:renovate-upstream-fork`
instead. This explicitly enables fork processing and limits Renovate to shared
first-party workflow/action pins, using the same CI-gated automerge policy.
All other dependency upgrades come through the reviewed upstream tracker.


```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["github>codeandsolder/ci-workflows:renovate-fleet"]
}
```

| Update | Central behavior |
| --- | --- |
| All proposed updates (including major, pre-1.0 minor, replacements and toolchain updates) | PR automerge after green checks and applicable release-age checks |
| Compatible stable Cargo minor/patch | Grouped into one green-CI merge |
| Native dated Rust nightly | Weekly, quarantined and CI-gated |
| Shared CI and strict Rust SHA updates | Grouped; PR automerge after consumer CI succeeds |
| Lockfile maintenance | Weekly, PR automerge after green checks including newly introduced external crates.io versions |

Direct workflows resolve the native root Rust toolchain manifest with the shared resolve-rust-toolchain action, and pass its channel output to setup-sccache and rustup. Do not maintain multiple version literals or workflow environment pins. Renovate owns dated nightly updates.

Use immutable SHA references to shared workflows and actions with a tracking `# main` suffix:

```yaml
uses: codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@<full-sha> # main
```

`platformAutomerge: false` and `ignoreTests: false` deliberately require Renovate itself to observe passing branch checks; this matters for repositories without GitHub required-check protection. A repository without checks **does not automatically merge**. The final source-based Renovate rule requires a 72-hour release age for Cargo registry crate releases. First-party Git dependencies and pinned shared CI SHAs do not incur a release-age delay. The independent Cargo lockfile gate checks newly introduced registry versions, including transitive dependencies, in every consuming repository regardless of its owner. A registry crate is not first-party merely because its metadata claims a codeandsolder repository; registry exceptions would require independently verified ownership. Other dependency ecosystems retain their existing no-age defaults. Ordinary failed, pending, or unknown CI checks still block automerge. Native GitHub automerge is a per-repository opt-in only after verified required terminal CI contexts are enforced by branch rules and native automerge is enabled; do not turn it on fleet-wide before that migration.

The Cargo manager enables Renovate's package-manager release-age synchronization with a three-day resolver floor. Cargo 1.100 or newer filters newly selected registry releases during ordinary lockfile updates and lockfile maintenance, including transitive registry dependencies of first-party Git updates. The floor applies only to Cargo; first-party Git revisions themselves are not aged. The independent lockfile quarantine remains mandatory, including for security updates (which Renovate deliberately does not apply its resolver floor to), old Cargo versions, and local registry overrides. The resolver reduces failed CI attempts; it is not a substitute for the gate.

### Keep routine dependency maintenance from flooding CI

The fleet allows at most one newly created Renovate PR and one automated Renovate branch commit per repository per hour (`prHourlyLimit: 1`, `commitHourlyLimit: 1`). The commit limit covers creation **and automatic rebases**, which both start CI. The six-open-PR ceiling limits outstanding dependency updates; it is not a runner-concurrency limit. Use `rebaseWhen: auto` so automerging and up-to-date-required PRs keep their necessary rebase checks. Deliberate manual rebase requests and vulnerability-alert fixes retain Renovate's native priority exceptions. This is ingress throttling, not an Actions job priority or a fleet-global cap. Do not add a release-age delay or skip correctness checks.

Central changes do **not** override project-specific `packageRules` applied later. Remove old local `automerge: false` and approval-only overrides when migrating; keep genuine version constraints, grouping and upstream ownership exclusions. Changes to the shared CI's callable workflow inputs may break consumers; those PR checks must be repaired, not bypassed. Do not manually merge ordinary green PRs seconds after they appear: Renovate merges on later runs and insists that the head be up-to-date.

These rules standardize execution by repository visibility, not by a host's name or incompatible repository-specific runner labels. They do not force a common compiler/target choice or release artifact across project boundaries. The reusable `rust-sccache.yml` and shared setup/finalize actions implement those common mechanisms; callers provide the commands and target matrix needed by their own products.


Rust validation uses explicit named `test-suites` in the shared Rust workflow.
Each scope executes Nextest once and derives the authoritative full regression
result, per-test baseline, shadow prediction and optional HTML/LCOV/JSON coverage
from that same instrumented execution. Keep only non-overlapping setup, build,
lint and validation in `command`. Separate doctest scopes remain authoritative.
An empty test-suites input executes only the caller command; no hidden extra
test pass is performed. Shadow prediction is advisory until verified.
See [Unified Rust test suites](.github/actions/rust-test-impact/README.md) for
the schema, feature/target separation and subprocess profiling requirements.

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

### Independent reference tools

A caller that needs Python-based reference tooling may set `uv-version` to an
exact version (for example, `"0.13.9"`). The workflow uses the shared pinned
setup-uv action with package caching disabled; the caller owns interpreter and
package provisioning in its explicit asset tree. No venv/pip bootstrap is
needed. Leaving the input empty skips uv installation entirely.

A caller that runs JavaScript reference/runtime tests may set `node-version`
to the required Node.js version (for example, `"26.13.1"`). The reusable workflow
uses the pinned setup-node action with automatic package-manager caching
disabled. The selected Node executable is available to the caller and all its
test subprocesses; leaving the input empty skips provisioning. Tests for
ECMAScript explicit resource management must not depend on the hosted image's
default Node release.

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

### Portable CI runners and inputs

Ordinary jobs must not select physical host identity labels such as `acer`
or `asus`. Use `[self-hosted, Linux, X64, local-ci]` for private Linux
builds, or a real prerequisite capability when a job genuinely needs a
specific platform, licensed application or benchmark hardware. Confirm
that matching runners exist before enabling a new private gate or an
automatic specialized job. Physical labels remain useful in inventory.

Do not refer to developer home directories, scratch paths or host-only
prepared toolchains from workflows. Use the runner's temporary directory,
digest-pinned containers, checked-in versioned inputs, or authenticated
artifact downloads with content verification. Clean job-owned temporary
files and containers after upload. The existing managed sccache paths
are the shared runner contract, not a project-specific cache provisioning
mechanism.

#### Private runner admission

Before publishing a new private CI caller, use the installation's authenticated
GitHub CLI (on the controller, not in the PR's unprivileged CI job):

```sh
node scripts/runner-availability.mjs require codeandsolder/REPO self-hosted Linux X64 local-ci
```

An idle or busy *online* matching registration is sufficient for admission.
No registration or offline-only matches fail admission. Never substitute a
public hosted runner for a private missing capability.

```sh
node scripts/runner-availability.mjs audit
```

The read-only fleet scan expands queued and running workflow records into actual
jobs, using GitHub's resolved labels (not a homemade matrix evaluator), and
distinguishes missing registrations, offline pools, busy pools, available capacity,
non-self-hosted jobs and unresolved selectors. API failures are reported as errors,
not empty inventories. Explicitly pass repository names to limit the audit.

The generic admission decisions run in the single shared Rust/WASI policy
module, using a batched native GitHub transport bridge. Hosted-runner labels
are recognized by the guest, so the audit only accesses private runner
registrations for custom selectors. See
[portable runner policy](policy-wasm/RUNNER_ADMISSION.md) for the JSON contract,
semantics and parity tests.

Contribution-only forks (Anubis, Hayro) are excluded from automatic fleet maintenance and runner admission through `scripts/fleet-scope.mjs`. Do not onboard or update their CI except for upstream-directed contribution work.

## Upstream-tracking forks

Use the pinned reusable workflow `.github/workflows/upstream-tracking.yml` with
one daily UTC cron (manual dispatch is also age- and daily-rate-limited).
Do not introduce independent sync, rebase, or upstream parity schedules.

The observer stores an append-only Git state history on
`automation/upstream-observations`; the state tree contains only observation
metadata, not upstream code. The cursor selects the newest **actually observed**
upstream snapshot that has aged at least 72 hours and is still reachable from
the fetched upstream branch. A newly pushed backdated commit cannot bypass the
quarantine. The initial observation ages for three days before it can be
adopted; continuously moving upstreams continue to advance on mature
snapshots. Force-pushed-away observations are discarded. The UTC-day attempt
is recorded before fetching and is not reset on failure.

The tracker rebases the fork-only commits onto the mature upstream revision,
retaining their authors and messages and dropping already-absorbed and empty
patches. Upstream owns dependency upgrades; do not independently duplicate
them in a lightweight fork. Existing merge-based histories are normalized
against their existing upstream anchor before advancing; any historical
merge-resolution edits are retained explicitly, with an exact-tree check.
Legacy reviewed-source checkpoints are migrated into real upstream ancestry
on the next successful rebase. A new source conflict blocks publication.

The reviewed fork-specific validator is the source-quality and behavioral
gate for automatic integration. Do not impose first-party strict Rust/Python
or clone-regression policies on inherited upstream source. Ordinary
first-party CI remains unchanged. Preparation creates an exact Git bundle;
validation and publication use the same immutable candidate in distinct
read/write jobs. Rust candidates retain the 72-hour external crates.io release
gate and mandatory sccache. Workflow edits require review; preserve mode
keeps the exact reviewed workflow tree and reports upstream drift separately.

Publication verifies that the mature upstream revision is an ancestor of the
validated candidate. It atomically archives the previous fork HEAD at
`refs/tags/fork-history/<old fork SHA>/<accepted upstream SHA>` and updates the target branch with an exact
expected-base lease. Old Git dependency pins therefore remain reachable. The accepted upstream
identity also prevents an upstream history rewrite from turning discarded
upstream commits into downstream patches.
A competing target update or inconsistent archive blocks both changes.
Existing released version tags are never moved.

For reproducible generated files, configure `generated-files`
(whitespace-separated exact tracked regular file paths), `generation-script`
(a script reviewed on the fork base), and `generation-container` (a digest-pinned
image). Historic generated-file edits are omitted from the rebased patches;
the new upstream artifact, or a reviewed fork-only seed, is regenerated in a
read-only job. That job retains external crate age checks and mandatory
sccache where applicable, exporting at most one generated commit. Validation
consumes that bundle in a fresh checkout, and publication independently
checks its exact parent and file allowlist. Non-generated source conflicts
still require review.

For release-driven forks, set `upstream-release-prefix` (for example
`crate-v`). The observer chooses the highest published stable semantic version
in that series on the configured upstream branch, rather than untagged commits.
Tag identity is part of the 72-hour observation state; removed, retargeted and
prerelease tags cannot pass the gate. The validator also receives the eligible
upstream tag as its third argument and should check the actual package version.
After validation and exact-revision integration, publication creates the fork's
`vMAJOR.MINOR.PATCH` tag and GitHub release with the upstream tag and both commit
identities in the notes. Tags are immutable; a conflicting tag fails instead of
being moved. This is GitHub release publication, not crates.io or npm publishing.

Tracking failures open/update a single issue including the upstream tip,
eligible revision, fork base and run URL. Quarantine is a pending state, not an
error. A successful retry closes the old failure issue. Do not force the cursor
or edit first-observed timestamps to bypass the quarantine.

## Fleet Rust compiler updates

Routine Rust work uses a native root rust-toolchain.toml with a dated nightly.
The fleet shares the same Renovate update policy and initial pin, not a
global transaction or cross-repository rollback. Local Cargo, tests, Clippy
and compiler-cache selection all use that repository's native pin. Routine
shared CI requires it and rejects a mismatching explicit compiler input.
Stable toolchains are reserved for explicit release compatibility contracts.
Any proposed Renovate toolchain update must pass its own CI.

Renovate's built-in rust-toolchain manager proposes a separate compiler PR
for each repository on Mondays (UTC), with CI-gated PR automerge after
successful checks. An unsuccessful repository stays on its previous pin
without blocking the others. Existing PRs can merge when green; compiler
update commits are limited to the weekly window. Normal shared CI uses the
caller's pin rather than the provider's own pin, so temporary differences
are permitted.

Renovate's Rust datasource supplies publication dates rather than exact times.
Its four-day minimum release age accounts conservatively for that precision;
the shared resolver independently enforces the real 72 elapsed hours using
the official dated manifest's publication timestamp. Normal Rustup installation
and Clippy, rustfmt, required targets and components must succeed. Upstream
issue labels are not promotion criteria. A compiler regression should acquire
a regression test rather than an issue filter.

Only the native root dated nightly receives the weekly nightly-specific schedule and age policy.
Shared runners must never run `rustup default` in a workflow. Install explicitly
with `.github/actions/install-rust-toolchain`; when a job must select an
explicit compiler, use its job-local selection option.

Do not duplicate compiler versions in environment variables, workflow inputs,
or scripts. Every normal check must use the native pin, and required tests,
strict lint and any relevant package or cross-target checks must run on
compiler-pin-only PRs. No special scheduler, credentials or cohort registry
are required. Stable or independently pinned release compatibility jobs stay separate.

### Provider CI scheduling

Provider policy tests share the portable-policy workflow and a single Linux build. Its WASI fixture suite runs against both the freshly built and checked-in bundle; Windows and macOS test the checked-in bundle. The same Linux job also exercises real quarantine transport and composite-action behavior. Provider workflow validation and toolchain/cache policy checks run together in provider-checks. Clone, language and Rust integration canaries use targeted inputs rather than triggering on unrelated policy fixtures or README edits. Reusable consumer workflows are unchanged.
