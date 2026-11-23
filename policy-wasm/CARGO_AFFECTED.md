# Shared affected-package CI policy

The cargo-affected composite action runs package-impact decisions in the
digest-pinned shared Rust/WASI policy module. Only Git and Cargo invocation,
JSON input/output transport and spawning the final Cargo command execute on the
host. The consumer does not compile the policy module or install Python.

Use one immutable codeandsolder/ci-workflows commit for all plan and run
invocations. The caller's own .github/cargo-affected.json declares its
repository-specific path rules and CI matrices. The built-in algorithm uses
cargo metadata --format-version 1 --no-deps, reverse local-workspace dependency
closure and git diff --no-renames --name-only -z BASE...HEAD. Unknown root
inputs or globally significant files select every workspace member; failing
Cargo/Git input or metadata is an error, not an empty plan.

Configuration fields:

- full_paths, full_prefixes: force full workspace CI.
- ignored_paths, ignored_prefixes: changes irrelevant to Cargo CI (only
  when they do not also belong to a workspace member).
- triggers: flag, paths, prefixes, packages. A matched trigger sets its named
  extra flag and selects its packages and their reverse dependency closure.
  All flags are true on a non-PR event; package names must exist.
- matrices: full and partial arbitrary JSON values, typically GitHub
  matrix objects with an include array.

Exact paths match files, prefix paths match directory boundaries (so
crates/one never matches crates/ones). On pull requests the algorithm
preserves the caller's independent extra flags even when an unrelated change
forces a full Cargo run. The shared action exposes affected_packages,
has_code, run_full, test_matrix and extra_flags as GitHub outputs.

Caller example (replace COMMIT with an immutable provider SHA):

~~~yaml
- name: Plan affected packages
  id: plan
  uses: codeandsolder/ci-workflows/.github/actions/cargo-affected@COMMIT
  with:
    mode: plan
    event: ${{ github.event_name }}
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.event.pull_request.head.sha || github.sha }}
~~~

For a downstream job with needs: prepare, use mode: run and pass
packages: ${{ needs.prepare.outputs.affected_packages }} with a JSON command
array such as command: '["cargo","nextest","run","--no-tests=pass"]'.
The WASM guest validates package names and inserts -p PACKAGE in the
appropriate location for Cargo build/check/clippy/test, Nextest, or cargo-ndk
build. The host uses argument-vector process invocation, never a command shell.
The action's mode=run should only execute if has_code is true.

The provider's cargo-affected.test.mjs runs Git and Cargo against a disposable
two-crate workspace and compares the same compiled and distributed WASI binary.
policy-wasm/src/cargo_affected.rs has focused unit tests covering dependency
closure, WIT-style triggers, unknown files, ignored paths, non-PR full builds,
Windows path normalization and invalid package names.
