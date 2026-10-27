# ci-workflows

Centrally managed reusable GitHub Actions workflows for `codeandsolder` repositories.

## Rust runner-local sccache

`.github/workflows/rust-sccache.yml` runs a caller-supplied Rust command on a GitHub-hosted runner using the maintained `codeandsolder/sccache-deduplicated` client.

Compiler outputs are cached only inside that runner for the lifetime of the job. There is no persistent compiler cache, rolling L0 snapshot, delta artifact, merger workflow, Garage promotion, tailnet access, CI credential broker, GitHub cache-runtime integration, Cargo wrapper, or cross-run path-canonicalization layer.

The workflow keeps one ordinary immutable `actions/cache` entry for the released `sccache` helper binary so an identical tool does not need to be downloaded on every job. That cache contains no compiler outputs.

The caller controls the Rust toolchain, components, targets, `RUSTFLAGS`, runner label, timeout, and command. Cargo uses the stock toolchain client and writes build outputs to a runner-local target directory.
