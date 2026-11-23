# Informational Rust test-impact shadow

The shared `rust-sccache.yml` enables advisory test-impact analysis **by
default** on ordinary Linux PR and main-branch jobs with a Cargo workspace at
`test-impact-working-directory` (default `.`). It runs the caller's command
unchanged, then collects a baseline on main or compares against the complete
Nextest suite on a PR. The additional work is informational: failures cannot
hide or override the caller's Rust CI result. Set `test-impact-mode: none` to
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

The current installation pins the exact source commit
[codeandsolder/cargo-affected 3f5d5aad](https://github.com/codeandsolder/cargo-affected/commit/440c5b69bf46e6c46b58f949de1081da509c50b6),
which contains the nested Cargo-workspace Git-path fix proposed upstream in
[max-sixty/cargo-affected #167](https://github.com/max-sixty/cargo-affected/pull/167).
It is built through Cargo with the workflow's managed sccache client, rather
than substituting a prebuilt official 0.4.1 binary that still misses nested
workspace changes. The tool revision is part of the cache key; old coverage
maps are never reused across this change.

Shadow selection remains advisory: the upstream project does not yet guarantee
absence of false negatives for build scripts, non-Rust inputs or external state.

For the local comparison parser contract:
node --test .github/actions/rust-test-impact/compare.test.mjs.

The shared provider runs its own Rust/WASI policy crate (policy-wasm) as the
first canary in rust-test-impact-smoke.yml. This is an actively changed nested
Cargo workspace with 47 unit tests. Until the upstream path fix is released,
shadow comparisons on this crate can observe missed regressions caused by the
known Git-root mismatch; they never omit tests from the full run.
