# Workflow-concurrency acceptance corpus

`workflow-concurrency.json` freezes **56 complete YAML fixture cases** from the
retired independent Python/PyYAML reference. The one-time capture preserved
all workflow source files and full normalized violation sets: **25 accepted
and 31 rejected** scenarios. Error messages from malformed YAML are normalized
to the `invalid YAML` category so parser diagnostics remain portable.

The corpus covers PR versus PR-target behavior, merge/push/workflow-call
collisions, selective versus unconditional cancellation, opened/closed one-shot
events, mixed-event fallbacks, global-snapshot comments and their validity
conditions, comment-triggered identities, YAML anchors, case-insensitive
workflow names including Unicode case folding, GitHub-expression literals,
physical host identity hidden in matrix or reusable-workflow inputs, hard-coded
host-local execution paths, and CRLF.

`node policy-wasm/concurrency.test.mjs policy-wasm/module.json` materializes
each fixture in an isolated checkout, invokes the **actual Rust/WASI portable
concurrency checker**, and compares the exact (normalized and sorted) policy
violations and exit status with the frozen reference. An additional test
validates the repository's actual checked-in workflows. The same tests run
against the rebuilt WASI artifact on Linux and the bundled artifact on
Linux/macOS/Windows.

This is not a second policy implementation. The source Python oracle is
intentionally retired; changes to expected policy decisions require review
of the original independent fixture and resulting behavior, not generating
expectations from the current production checker.
