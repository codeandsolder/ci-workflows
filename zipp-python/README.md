# Shared Zipp Python runner

Runs the Python code that is intentionally retained in CI against the pinned
Zipp Rust virtual machine. Uses the same WebAssembly engine on Linux, Windows
and macOS; no CPython, pip or npm installation for these tasks.

The upstream v0.0.38 release (commit 8cb8399f4f63fa3bebb3298da6f25cda0ecf5395)
provides the Brotli-compressed JavaScript/Python-base engine and its
single-file loader. The release manifest pins the upstream artifact and
embed-kit digests and the extracted loader digest. The Apache license is
included. No Torch package is needed. These are intentionally bundled
third-party runtime files, not local build output.

Run on Node 24+:

    node zipp-python/run.mjs CHECKOUT TASKS.json TASK [ARGUMENTS...]

Each task declares an entry path, required read globs, optional read globs,
allowed write globs, and optional guest-only scratch globs. All are relative
to the checkout. A guest never sees incidental repository files, host
processes or network. Input symlinks are rejected; guest write reports are
validated before publication, and failed runs publish no changes. A task may
not access Git metadata. Scratch changes are discarded. Inputs are limited by the embedded engine's size and execution budgets.
A task can declare a virtual `stdin` filename; host stdin is exposed only as
that file, without materializing it in the checkout.

The host adapter deliberately does not implement missing Python standard
library modules. Operations requiring processes or network belong in the
native orchestration layer. Keep CPython-based differential reference tests
independent until their dependencies are actually supported; do not silently
substitute another parser or fall back to CPython on guest failure.

The v0.0.38 update adds Python `tomllib`, `shlex`, `datetime`, `unittest`,
`unittest.mock`, and `importlib.util`, proper text newline handling, real ZIP
DEFLATE, and Unicode regex and explicit script-path fixes. The regression
suite verifies these capabilities against the pinned embedded module. Third-
party Python packages such as PyYAML must still be explicitly provided to
the scoped guest filesystem; they are not part of the standard library.
