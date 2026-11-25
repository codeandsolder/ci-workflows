# Shared Rust/WASI Renovate quarantine recheck decisions

The hourly Renovate controller handles only GitHub API reads, exact PR/head
revalidation, and authorized job rerun requests. Its generic decisions live in
policy-wasm/src/renovate_recheck.rs and run in the same digest-verified
Rust/WASI module as the shared CI quarantine itself.

The renovate-recheck JSON stdin policy accepts one of four operations:

- hold: parse a GitHub Actions failed-job log into a strict release-age hold
  and a collection of crate publication deadlines, or an ineligible reason
- job: require a completed failing job whose head matches the open PR, on
  attempt one, and whose failed steps are all quarantine steps
- checks: require every reported check completed, and every failing
  check to belong to GitHub Actions, producing the complete eligible set
- eligibility: compare the latest eligible-at time against the current
  timestamp plus the configured grace interval

The parser supports GitHub timestamp prefixes, ANSI CSI color sequences,
multiple age-held crate blocks, Gregorian dates, UTC offsets and fractional
seconds. Sub-millisecond timestamps are rounded up (a safe extension of the
original JavaScript parser, never an early release). Incomplete or malformed
evidence does not authorize a rerun.

The native controller performs complete pre-mutation GitHub head, check and
job revalidation even after the WASI decisions succeed. The source is pulled
fresh before the hourly systemd service executes, preserving the default
read-only mode, hourly schedule and the 72-hour quarantine plus 15-minute
grace period. The WASM guest never issues GitHub mutations.

Run the independent unit tests against both the built and packaged module:

    node scripts/renovate-quarantine-recheck.test.mjs policy-wasm/module.json
    node --test scripts/renovate-quarantine-recheck.integration.test.mjs

The integration test uses a local fake gh executable to prove that a dry
run cannot mutate, mixed failures block reruns, and multiple aged failures
are only rerun together when each qualifies. The provider's portable-policy
CI suite additionally covers compiled and packaged WASM on Linux, macOS and
Windows, with strict Clippy and reproducible byte-for-byte module verification.
