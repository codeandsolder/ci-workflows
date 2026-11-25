# Portable runner admission policy

Runner registration, availability and hosted-runner recognition are generic
GitHub Actions policy decisions. They live in runner_admission.rs in the
existing shared, digest-verified Rust/WASI CI policy module, not in a separate
runtime or per-repository workflow.

## Policy boundary

The host adapter scripts/runner-availability.mjs owns only authenticated
GitHub API requests (workflow runs, resolved job selectors, runner
registrations), pagination and CLI JSON transport. It never reconstructs
Actions job labels from YAML or guesses matrix expansion.

The portable runner-admission operation takes JSON:

- mode: audit (treat GitHub-hosted singleton labels separately, allow
  unresolved empty job selectors), or require (enforce nonempty labels)
- requests: an ordered array of label arrays, one per job
- runners: GitHub registration objects with name, status, busy, and labels

It returns a same-length array of decisions with status not-self-hosted,
unresolved, unregistered, offline, busy or available, plus the names
of matching, online and idle runner registrations. All matching is
case-insensitive; a runner must contain **every** requested label. Unknown
custom labels fail admission; busy but online eligible capacity is accepted.

The native audit batches jobs into one WASM invocation. It first classifies
against an empty runner inventory and only calls the private runners API if
some job needs a custom registration. It reruns the same entire batch with
the actual registrations, at most once. That avoids both per-job WASM startup
costs and unnecessary API permission/rate-limit requirements for ordinary
GitHub-hosted jobs. No external side effects are performed by the guest.

The shared native bridge in policy-wasm/bridge.mjs is also used by the stable
Rust release-review host. It is limited to process/JSON transport, with no
independent policy implementation.

## Regression coverage

The Rust unit tests cover exact hosted-selector families, offline/busy/idle
selection, case-insensitive matching, missing busy state, malformed input,
and stable output order. The independent JavaScript test oracle checks the
complete WASM decision against 300 mixed-label selections in one batch; the
host tests verify pagination and that hosted-only jobs never require a
private runner API call.

The portable CI matrix runs Node tests against both the compiled WASM and
the packaged release module, on Linux, macOS and Windows, while the normal
shared policy gates retain strict Clippy, reproducible WASM verification and
the mandatory managed sccache configuration.

The fleet-wide allowlist of first-party/contribution-only repositories remains
in scripts/fleet-scope.mjs because it is fleet-specific configuration,
not a generic runner matching rule.
