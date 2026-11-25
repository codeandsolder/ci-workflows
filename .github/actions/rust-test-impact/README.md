# Unified Rust test suite

One authoritative instrumented Nextest execution produces:

- full per-test outcomes and the CI regression gate;
- a shadow selection report computed against the prior compatible baseline;
- a refreshed per-test coverage database;
- optional HTML, LCOV and LLVM JSON reports from the same indexed LLVM profile.

The provider does not implicitly duplicate a caller's opaque shell command.
Instead, explicitly specify the test scope, with the command containing only
non-overlapping setup, formatting, Clippy, builds and other validation:

```yaml
jobs:
  rust:
    uses: codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@<reviewed-provider-sha>
    with:
      command: cargo clippy --workspace --locked --all-targets --all-features -- -D warnings
      test-suite: |
        {
          "directory": ".",
          "cargo": ["--workspace", "--locked", "--all-features"],
          "nextest": ["--profile", "ci"],
          "doctests": ["--workspace", "--locked", "--all-features"],
          "coverage": true
        }
```

All arguments are arrays, passed directly without shell expansion. The
directory must be a workspace root within the caller checkout. Defaults are
directory ".", cargo ["--workspace","--locked"], nextest [], no doctests,
and aggregate coverage enabled. Keep doctests as a distinct scope when the
old authoritative command ran them; Nextest does not execute doctests.
Keep genuinely different feature/target matrices and instrumentation-sensitive
tests in their own jobs. Remove a standalone coverage job only when its scope
is covered by the unified suite. The standalone coverage workflow remains
available for different coverage scopes.

A full checkout is required for baseline ancestry. The cache scope incorporates
the immutable collector source, toolchain, runner, workspace, canonical test
arguments and Rust flags. Successful PR collections can be reused on that PR
ref; successful default-branch collections can seed future PRs. GitHub cache
ref isolation prevents publishing PR coverage directly to the default branch.
Incompatible or missing coverage is reported as not evaluable, not a false
negative-free observation. No tests are skipped in shadow mode.

The collector reuses its instrumented listing to compute the prediction before
updating the database. The coverage reporter reads the actual build directories
from Nextest metadata and generates all reports with `cargo llvm-cov report`,
which does not execute tests. Reports describe workspace code exercised in that
Nextest scope (doctests are separate). Coverage and comparison artifacts remain
advisory; failure of the authoritative full Nextest or configured doctest scope
fails the job.

The initial draft integration pin points to the upstream contribution branch
on the existing fork. Switch to an observed, reviewed upstream revision before
retiring the fork. Never deploy a floating branch or bypass managed sccache.
