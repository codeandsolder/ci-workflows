# Shared stable Rust release-review policy

The generic stable-Rust review queue is a shared CI workflow. The native Node
adapter is responsible only for HTTPS transport, GitHub label/issue API calls,
and checked JSON transport to the existing digest-verified Rust/WASI policy
module. The Rust guest owns official release manifest TOML parsing, semantic
date/version validation, the immutable review issue content, and matching
prior review issues across all paginated open/closed GitHub issue results.

The guest exposes two JSON-stdin / JSON-stdout commands:

- stable-release-parse: input object with manifest string; output exact stable
  release version and ISO date.
- stable-release-plan: input release/version/date plus issues as pages of
  GitHub issue objects; output existing issue number or proposed new issue
  title/body. It rejects malformed inputs rather than creating duplicates.

The host first asks WASI to validate the release before making GitHub calls,
then requests the final issue decision after retrieving the exact all-state
issue list. A found issue is never refreshed/reopened; newly created issues
retain the original automation marker. The native adapter validates the
GitHub repository identifier; only the host can create labels or issues.

The calling repository invokes the shared reusable workflow, pinned by full
commit SHA. Its provider checkout contains exactly the shared script and
portable module loader, manifest and compressed WASM, without duplicating
project-specific scripts or requiring Python. The source provider is updated
and tested centrally, and its exact-byte reproducible WASI build is checked
against the committed module before deployment.

The provider's Rust tests cover malformed manifests, correct tag/version
subsection, Gregorian leap dates, exact marker deduplication and malformed
GitHub response bodies. The independent Node test retains release queue
behavior and validates the production provider's compiled and digest-verified
WASM policy on Linux, macOS and Windows.
