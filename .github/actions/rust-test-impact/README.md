# Informational Rust test-impact shadow

This is an **opt-in replacement for a full Nextest test job**, not a second
test run. On a pull request, it executes the entire Nextest suite once and
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

Main-branch collection currently adds a second instrumented compilation beside
an independently enabled rust-coverage.yml job. Do not enable both without
understanding that cost. The lightweight selection on PRs reuses the full
Nextest build output and ordinarily takes a fraction of a second after the
suite finishes. No tests are skipped.

The current installation pins cargo-affected 0.4.1. It is known to
underselect on nested Cargo roots: Git paths are repository-relative, while
this version stores coverage paths workspace-relative. This limitation is
intentionally visible in shadow results, and must be fixed upstream and
the tool repinned before using it to skip any tests. Regression and corrected
source are in the separate local cargo-affected worktree; the author is not
maintaining a compatibility wrapper for the bug.

For the local comparison parser contract:
node --test .github/actions/rust-test-impact/compare.test.mjs.
