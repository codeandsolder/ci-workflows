# Informational Rust test-impact shadow

The shared `rust-sccache.yml` enables advisory test-impact analysis **by
default** on ordinary Linux PR and main-branch jobs with a Cargo workspace at
`test-impact-working-directory` (default `.`). It runs the caller's command
unchanged, then collects a baseline on main or compares against the complete
Nextest suite on a PR. Analysis also runs after a failed caller command, because failing tests
expose missed regressions. It cannot hide or override the caller's Rust CI result. Set `test-impact-mode: none` to
disable it, or set `test-impact-working-directory` and
`test-impact-cargo-args` for a non-root workspace or custom test arguments.
Release-tier jobs, tag events, non-Linux runners, and informational coverage
jobs do not start automatic impact analysis.

The dedicated `rust-test-impact.yml` workflow can still replace a full
Nextest job when test-impact analysis itself is the intended job. On a pull
request, it executes the entire Nextest suite once and
compares failing test identities against the cargo-affected status selection
computed from the latest compatible main-branch coverage baseline. The
comparison never affects the test gate; an actual full-suite failure still
fails CI. Missing or incompatible baseline data is reported as not evaluable,
not counted as zero missed regressions.

On default-branch pushes, it runs cargo affected collect, which executes an
instrumented full Nextest suite. Successful baselines are stored in Actions
cache by compiler, architecture, Cargo arguments, workspace path, and source
commit. The selector uses Git history, so PR checkouts fetch the full repository
history. The initial baseline is absent until the first successful main push.

Consumer workflow (call on both PRs and main pushes):

    jobs:
      test:
        permissions:
          contents: read
          actions: read
        uses: codeandsolder/ci-workflows/.github/workflows/rust-test-impact.yml@<full-provider-sha>
        with:
          working-directory: .
          cargo-args: --workspace --locked

Automatic mode adds instrumented baseline collection on main, and an
additional full Nextest run plus comparison on PRs. This reuses managed sccache
but does incur extra CPU time; the ordinary caller command remains authoritative.
The dedicated mode avoids a second test run when it replaces an existing
full-Nextest job. The lightweight selection on PRs reuses the full
Nextest build output and ordinarily takes a fraction of a second after the
suite finishes. No tests are skipped.

The current installation pins the upstream source commit
[max-sixty/cargo-affected 155695f2](https://github.com/max-sixty/cargo-affected/commit/155695f2dd6d66c41400ffb11d8883e946fa3b0d),
which includes the Git-root coverage path fix in
[upstream #170](https://github.com/max-sixty/cargo-affected/pull/170)
and the incremental-collection backstop fix in #169. It is built with
managed sccache, rather than using the older 0.4.1 release.
The upstream source revision and source identity are part of the cache key;
migration intentionally starts with a fresh baseline because upstream did
not adopt the fork's coverage-path fingerprint component.

Shadow selection remains advisory: the upstream project does not yet guarantee
absence of false negatives for build scripts, non-Rust inputs or external state.

For the local comparison parser contract:
node --test .github/actions/rust-test-impact/compare.test.mjs.

The shared provider runs its own Rust/WASI policy crate (policy-wasm) as the
first canary in rust-test-impact-smoke.yml. This is an actively changed nested
Cargo workspace with 47 unit tests. The canary exercises the upstream Git-root path fix; shadow comparisons never
omit tests from the full run.
