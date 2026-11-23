# Shared Rust CI sccache policy acceptance

`rust-ci-sccache.json` freezes 48 complete inputs and exact diagnostic sets
from the retired independent Python/PyYAML oracle (13 accepted, 35 rejected).
Thirteen cases include nested shell files. The corpus was recorded once using
`uv` and a temporary AST instrumentation script under
`/home/jan/build/ci-workflows/sccache-policy/record.py`, **not** by
asking the Rust implementation to generate its own expectations.

The fixtures test canonical setup/finalize ordering and trust identity,
reusable strict workflows, untrusted relative actions, forbidden rust-cache
actions, noncompiling cargo commands, complex nested shell script invocation,
source recursion, changing working directories, dynamic unresolved scripts,
shell function/case/array parsing, heredocs, source files without extensions
or executable bits, multiline shell commands, YAML anchors and merge
overrides, and CRLF.

`policy-wasm/sccache.test.mjs` executes the actual production Rust/WASI
module against each isolated fixture, compares full sorted diagnostics and
exit status, and verifies the real checked-in provider workflow inventory.
The test runs against the freshly compiled binary on Linux and the bundled
binary on Linux, macOS, and Windows. No second parser or Python fallback
remains. The centrally managed sccache and 72-hour external-crate quarantine
must remain mandatory.

Review each expected diagnostic when changing policy; never refresh this
corpus mechanically from the implementation being tested.
