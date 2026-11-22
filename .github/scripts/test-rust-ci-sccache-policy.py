#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import subprocess
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / ".github/scripts/rust-ci-sccache-oracle.py"
spec = importlib.util.spec_from_file_location("check_ci_sccache_policy", SCRIPT)
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

SHA = "1" * 40
STRICT_SHA = "2" * 40

parser = argparse.ArgumentParser()
parser.add_argument("--wasm", type=Path)
args = parser.parse_args()
WASM = args.wasm.resolve() if args.wasm is not None else None


def compare(root: Path, expected: list[str], strict_ref: str | None = None) -> None:
    if WASM is None:
        return
    command = [
        "node",
        str(ROOT / "policy-wasm/run.mjs"),
        str(WASM),
        "sccache",
        str(root),
    ]
    if strict_ref is not None:
        command.append(strict_ref)
    result = subprocess.run(command, encoding="utf-8", capture_output=True, check=False)
    actual = [line[2:] for line in result.stdout.splitlines() if line.startswith("- ")]
    assert result.returncode == int(bool(expected)), (
        result.stdout,
        result.stderr,
        expected,
    )
    assert sorted(actual) == sorted(item.replace("\\", "/") for item in expected), (
        actual,
        expected,
    )


def inspect(workflow: str, strict_ref: str | None = None) -> list[str]:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        path = root / ".github/workflows/ci.yml"
        path.parent.mkdir(parents=True)
        path.write_text(workflow, encoding="utf-8")
        result = mod.inspect_root(root, strict_ref)
        compare(root, result, strict_ref)
        assert isinstance(result, list) and all(
            isinstance(item, str) for item in result
        )
        return [str(item) for item in result]


def assert_clean(workflow: str, strict_ref: str | None = None) -> None:
    violations = inspect(workflow, strict_ref)
    assert not violations, violations


def assert_blocked(workflow: str, fragment: str, strict_ref: str | None = None) -> None:
    violations = inspect(workflow, strict_ref)
    assert any(fragment in item for item in violations), violations


assert_clean(
    f"""
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: codeandsolder/ci-workflows/.github/actions/setup-sccache@{SHA}
      - run: cargo test --locked
      - if: always()
        uses: codeandsolder/ci-workflows/.github/actions/finalize-sccache@{SHA}
"""
)
assert_blocked(
    """
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: cargo test --locked
""",
    "missing canonical setup-sccache",
)
# Untrusted relative actions cannot impersonate the pinned cache provider.
for local_dir in ("./.github", "./.ci-workflows/.github", "./untrusted/.github"):
    assert_blocked(
        f"""
jobs:
  spoofed:
    runs-on: ubuntu-24.04
    steps:
      - uses: {local_dir}/actions/setup-sccache
      - run: cargo test --locked
      - if: always()
        uses: {local_dir}/actions/finalize-sccache
""",
        "missing canonical setup-sccache",
    )

assert_blocked(
    f"""
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: cargo check
      - uses: codeandsolder/ci-workflows/.github/actions/setup-sccache@{SHA}
      - if: always()
        uses: codeandsolder/ci-workflows/.github/actions/finalize-sccache@{SHA}
""",
    "runs after Rust tooling",
)
assert_blocked(
    f"""
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: codeandsolder/ci-workflows/.github/actions/setup-sccache@{SHA}
      - run: cargo test
      - uses: codeandsolder/ci-workflows/.github/actions/finalize-sccache@{SHA}
""",
    "must use if: always()",
)
assert_blocked(
    f"""
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: codeandsolder/ci-workflows/.github/actions/setup-sccache@{SHA}
      - uses: Swatinem/rust-cache@v2
      - run: cargo test
      - if: always()
        uses: codeandsolder/ci-workflows/.github/actions/finalize-sccache@{SHA}
""",
    "Swatinem/rust-cache is forbidden",
)
assert_clean(
    f"""
jobs:
  build:
    uses: codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@{SHA}
    with:
      command: cargo test
"""
)
assert_clean(
    f"""
jobs:
  strict:
    uses: codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@{STRICT_SHA}
""",
    STRICT_SHA,
)
assert_blocked(
    f"""
jobs:
  strict:
    uses: codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@{"3" * 40}
""",
    "executing gate",
    STRICT_SHA,
)
assert_clean(
    """
jobs:
  metadata:
    runs-on: ubuntu-24.04
    steps:
      - uses: dtolnay/rust-toolchain@1111111111111111111111111111111111111111
      - run: |
          cat <<'EOF'
          Review rustc, Cargo, and Clippy changes.
          EOF
"""
)

# Non-compiling Cargo/toolchain operations do not need a compiler cache.
assert_clean(
    """
jobs:
  formatting:
    runs-on: ubuntu-24.04
    steps:
      - run: cargo +nightly fmt --all -- --check
      - run: cargo metadata --format-version 1
      - run: cargo --version
      - run: rustc --version
      - run: cargo package --no-verify
"""
)

# Compiling Cargo commands still require the canonical setup, including unknown
# cargo plugins because they may invoke rustc internally.
for command in (
    "cargo check --locked",
    "cargo +1.99.0 test --workspace",
    "RUSTFLAGS='-D warnings' cargo clippy --all-targets",
    "cargo doc --no-deps",
    "cargo miri test",
    "cargo nextest run",
    "rustc src/main.rs",
):
    assert_blocked(
        f"""
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - run: {command}
""",
        "missing canonical setup-sccache",
    )

# Heredoc documentation must not turn prose/examples into detected compilation.
assert_clean(
    """
jobs:
  docs:
    runs-on: ubuntu-24.04
    steps:
      - run: |
          cat <<'EOF'
          cargo test --workspace
          rustc src/main.rs
          EOF
"""
)

# Installation streams execute shell from stdin, not the first argument
# following `--`. rustup's "--default-toolchain" must not be mistaken for a
# locally executed script, or the strict gate falsely rejects valid installers.
for command in (
    "curl -fsSL https://sh.rustup.rs | sh -s -- --default-toolchain none -y",
    "curl -fsSL https://sh.rustup.rs | bash -es -- --default-toolchain none -y",
    "printf 'echo ok' | dash -s -- --default-toolchain none",
):
    assert_clean(
        f"""
jobs:
  installer:
    runs-on: ubuntu-24.04
    steps:
      - run: {command}
"""
    )

# Legacy cache actions are forbidden even if compilation is hidden behind a task
# runner and therefore cannot be proven from the workflow text alone.
assert_blocked(
    """
jobs:
  hidden-build:
    runs-on: ubuntu-24.04
    steps:
      - uses: Swatinem/rust-cache@v2
      - run: just test-cpu
""",
    "Swatinem/rust-cache is forbidden",
)


def inspect_tree(workflow: str, files: dict[str, str]) -> list[str]:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        file = root / ".github/workflows/ci.yml"
        file.parent.mkdir(parents=True)
        file.write_text(workflow, encoding="utf-8")
        for name, body in files.items():
            script = root / name
            script.parent.mkdir(parents=True, exist_ok=True)
            script.write_text(body, encoding="utf-8", newline="")
        result = mod.inspect_root(root)
        compare(root, result)
        assert isinstance(result, list) and all(
            isinstance(item, str) for item in result
        )
        return [str(item) for item in result]


def assert_tree_blocked(workflow: str, files: dict[str, str], fragment: str) -> None:
    violations = inspect_tree(workflow, files)
    assert any(fragment in violation for violation in violations), violations


# The real-world failure: a workflow invokes a local shell entrypoint that
# compiles Rust, but no inline Cargo command is visible to the old scanner.
plain = """
jobs:
  live:
    runs-on: ubuntu-latest
    steps:
      - run: ./ci/live-altcha-e2e.sh
"""
scripts = {"ci/live-altcha-e2e.sh": "#!/usr/bin/env bash\ncargo build --locked\n"}
assert_tree_blocked(plain, scripts, "missing canonical setup-sccache")
assert_tree_blocked(plain, scripts, "missing canonical finalize-sccache")

# Canonical actions around indirect work are sufficient.
assert not inspect_tree(
    f"""
jobs:
  live:
    runs-on: ubuntu-latest
    steps:
      - uses: codeandsolder/ci-workflows/.github/actions/setup-sccache@{SHA}
      - run: ./ci/live-altcha-e2e.sh
      - if: always()
        uses: codeandsolder/ci-workflows/.github/actions/finalize-sccache@{SHA}
""",
    scripts,
)

# Multiple local-script hops, environment assignments, source, and recursion.
assert_tree_blocked(
    """
jobs:
  indirect:
    runs-on: ubuntu-latest
    steps:
      - run: env MODE=ci bash ./ci/first.sh
""",
    {
        "ci/first.sh": "#!/bin/sh\nsource ./ci/second.sh\n",
        "ci/second.sh": "#!/usr/bin/env bash\ncargo +nightly clippy --all-targets\n",
    },
    "missing canonical setup-sccache",
)
assert_tree_blocked(
    """
jobs:
  cycle:
    runs-on: ubuntu-latest
    steps:
      - run: ./ci/a.sh
""",
    {
        "ci/a.sh": "#!/bin/sh\n./ci/b.sh\n",
        "ci/b.sh": "#!/bin/sh\n./ci/a.sh\nrustc src/main.rs\n",
    },
    "missing canonical setup-sccache",
)

# Both step-specific working directories and job defaults affect resolution.
for header in (
    "    defaults:\n      run:\n        working-directory: test-area",
    "",
):
    step_workdir = "" if header else "        working-directory: test-area\n"
    assert_tree_blocked(
        f"""
jobs:
  cwd:
    runs-on: ubuntu-latest
{header}
    steps:
      - run: bash ./run.sh
{step_workdir}""",
        {"test-area/run.sh": "#!/bin/bash\ncargo test --locked\n"},
        "missing canonical setup-sccache",
    )

# A cd inside a wrapper changes where nested relative script references resolve.
assert_tree_blocked(
    """
jobs:
  cwd-nested:
    runs-on: ubuntu-latest
    steps:
      - run: ./ci/runner.sh
""",
    {
        "ci/runner.sh": "#!/bin/sh\ncd scripts && ./compile.sh\n",
        "scripts/compile.sh": "#!/bin/sh\ncargo check\n",
    },
    "missing canonical setup-sccache",
)
assert_tree_blocked(
    """
jobs:
  inline:
    runs-on: ubuntu-latest
    steps:
      - run: bash -lc 'cargo test --locked'
""",
    {},
    "missing canonical setup-sccache",
)

# Unresolvable script paths cannot silently guarantee compiler caching.
for step in ('bash "$DYNAMIC_SCRIPT"', "bash ./ci/missing.sh"):
    assert_tree_blocked(
        f"""
jobs:
  unknown:
    runs-on: ubuntu-latest
    steps:
      - run: {step}
""",
        {},
        "unresolved local shell script",
    )

# Noncompiling Cargo queries and heredoc documentation in nested shell scripts
# must not cause spurious Rust compilation detection.
assert not inspect_tree(
    plain,
    {
        "ci/live-altcha-e2e.sh": """#!/bin/sh
cargo metadata --format-version 1
cargo +nightly fmt --all
cat <<'EOF'
cargo build
EOF
"""
    },
)

# Here scripts must remain data, not mistaken for executable local entrypoints.
assert not inspect_tree(
    """
jobs:
  data-only:
    runs-on: ubuntu-latest
    steps:
      - run: |
          assets=(
            dist/rust-skills.zip
            dist/SHA256SUMS
          )
          echo done
""",
    {},
)

# Sourcing shell fragments does not require an executable bit, a suffix or a shebang.
assert_tree_blocked(
    """
jobs:
  sourced:
    steps:
      - run: . ./ci/build.env
""",
    {"ci/build.env": "cargo build --locked\n"},
    "missing canonical setup-sccache",
)

# Shell commands provided on standard input through a heredoc are executable.
assert_tree_blocked(
    """
jobs:
  stdin-script:
    steps:
      - run: |
          bash <<'EOF'
          cargo build --locked
          EOF
""",
    {},
    "missing canonical setup-sccache",
)

# A dynamic shell -c command is unresolved, not proven to be non-compiling.
assert_tree_blocked(
    """
jobs:
  dynamic:
    steps:
      - run: bash -c "$MAYBE_BUILD"
""",
    {},
    "unresolved dynamic shell -c program",
)

# Unknown scripts still need both canonical actions, not merely setup.
assert_tree_blocked(
    f"""
jobs:
  incomplete:
    steps:
      - uses: codeandsolder/ci-workflows/.github/actions/setup-sccache@{SHA}
      - run: ./ci/generated.sh
""",
    {},
    "missing canonical finalize-sccache",
)

# Case patterns and array elements are data; inline commands after an arm
# separator still execute and must be traversed.
assert_tree_blocked(
    """
jobs:
  shell-case:
    steps:
      - run: ./ci/case.sh
""",
    {
        "ci/case.sh": """#!/bin/bash
paths=(
  ../*
  dist/file.zip
)
case "$MODE" in
  '../*') echo not-an-execution ;;
  build) cargo build --locked ;;
esac
"""
    },
    "missing canonical setup-sccache",
)

# Scripts without extensions are resolved through their shell shebang.
assert_tree_blocked(
    """
jobs:
  shebang:
    steps:
      - run: ci/worker
""",
    {"ci/worker": "#!/usr/bin/env bash\ncargo test --locked\n"},
    "missing canonical setup-sccache",
)

print("rust-skills2: nested shell CI sccache policy regressions passed")

# YAML merges must behave like the previous SafeLoader policy, including
# explicit overrides of merged fields and sequence precedence.
assert_blocked(
    """
defaults: &defaults
  run: cargo build --locked
jobs:
  merged:
    steps:
      - <<: *defaults
""",
    "missing canonical setup-sccache",
)
assert_clean(
    """
defaults: &defaults
  run: cargo build --locked
jobs:
  merged:
    steps:
      - <<: *defaults
        run: cargo metadata --no-deps
"""
)
assert_blocked(
    """
first: &first
  run: cargo fmt
second: &second
  run: cargo test
jobs:
  merged:
    steps:
      - <<: [*first, *second]
""",
    "missing canonical setup-sccache",
)

assert_tree_blocked(
    plain,
    {"ci/live-altcha-e2e.sh": "#!/bin/sh\r\ncargo \\\r\n build --locked\r\n"},
    "missing canonical setup-sccache",
)
