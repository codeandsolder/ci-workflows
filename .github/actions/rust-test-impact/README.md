# Unified Rust test suites

One authoritative instrumented Nextest execution **per named scope** produces
full regression results, shadow selection against the prior compatible
baseline, a refreshed per-test coverage database, and optional HTML, LCOV
and LLVM JSON from the same profile.

Explicitly specify disjoint test scopes; the caller command contains only
non-overlapping setup, formatting, Clippy, builds and other validation:

```yaml
jobs:
  rust:
    uses: codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@<reviewed-provider-sha>
    with:
      command: cargo clippy --workspace --locked --all-targets --all-features -- -D warnings
      test-suites: |
        [
          {
            "name": "unit",
            "cargo": ["--locked", "--lib", "--all-features"],
            "nextest": ["--profile", "ci"],
            "doctests": ["--locked", "--all-features"]
          },
          {
            "name": "integration",
            "cargo": ["--locked", "--test", "integration", "--all-features"]
          }
        ]
```

The input is a nonempty JSON array. Names are unique filesystem-safe identifiers.
Each scope defaults to directory ".", cargo ["--workspace","--locked"],
nextest [], no doctests, and aggregate coverage enabled. All arguments are
arrays, passed directly without shell expansion. The directory must be a
workspace root within the checkout. Distinct feature configurations, filters,
and nested independent workspaces can share a single CI job. Doctests are a
distinct scope and remain authoritative when configured. Binary-only packages
must omit doctests. Keep instrumentation-sensitive tests in their original
Cargo commands until equivalence is established.

Each scope has its own collector state directory, database, instrumented
build, and report subdirectory. The shared cache transports only databases;
scope hashes include the immutable collector and Nextest pins, compiler,
workspace, platform, Rust flags, and exact Cargo/Nextest arguments.
Changing one scope's arguments does not invalidate the other scopes' data.
Successful PR collections are reusable on the PR ref; default-branch
collections seed future PRs. Incompatible or missing data is reported as
not evaluable. No tests are skipped in shadow mode.

Instrumented build directories are removed after each scope's report so a
multi-feature job does not retain all the instrumented copies simultaneously.
Reporter/comparison failures are advisory. Every requested authoritative
scope executes even if an earlier one fails, and any failed execution fails
the job. Reports describe workspace code exercised in that scope; doctests
are separate.

On native Linux, set `"continuous": true` on a scope containing tests
that terminate subprocesses without normal exit. The collector verifies
LLVM's runtime support and maps counters continuously; the persistence mode
is part of both the database fingerprint and scope cache identity. When a
test constructs a sanitized child environment, explicitly preserve only
`LLVM_PROFILE_FILE` (if present), and ensure the directory is accessible
inside the child's sandbox. Wait for children before the test ends. Tests
that intentionally sever all profiling context remain separate full gates
or require explicit input rules.

For callers needing test-only isolation, use a Nextest run-wrapper configured
with `target-runner = "within-wrapper"` to execute the collector's runner
inside the caller's wrapper. Do not set a competing Cargo target runner.
Process-local serial-test locks do not serialize Nextest processes: configure
Nextest test groups for tests sharing ports, daemons, or other global resources.

The draft integration pin points to the upstream contribution branch on the
existing fork. Switch to an observed, reviewed upstream revision before
retiring the fork. Never deploy a floating branch or bypass managed sccache.
