#!/usr/bin/env python3
"""Reject Rust GitHub Actions jobs that bypass the canonical sccache setup."""

from __future__ import annotations

import argparse
import re
import shlex
from pathlib import Path
from typing import Any

import yaml

CANONICAL_WORKFLOW = "codeandsolder/ci-workflows/.github/workflows/rust-sccache.yml@"
STRICT_WORKFLOW = "codeandsolder/rust-skills2/.github/workflows/strict-rust.yml@"
CANONICAL_SETUP = "codeandsolder/ci-workflows/.github/actions/setup-sccache@"
CANONICAL_FINALIZE = "codeandsolder/ci-workflows/.github/actions/finalize-sccache@"
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
CARGO_NON_COMPILING = {
    "add",
    "audit",
    "clean",
    "deny",
    "fetch",
    "fmt",
    "generate-lockfile",
    "info",
    "init",
    "locate-project",
    "login",
    "logout",
    "machete",
    "metadata",
    "new",
    "owner",
    "pkgid",
    "read-manifest",
    "remove",
    "report",
    "search",
    "tree",
    "update",
    "vendor",
    "verify-project",
    "yank",
}
PROBE_ARGS = {"--help", "-h", "--version", "-V", "-vV"}
RUST_COMPILE_ACTIONS = ("houseabsolute/actions-rust-cross@",)


def external_ref(uses: str, prefix: str) -> str | None:
    if not uses.startswith(prefix):
        return None
    return uses[len(prefix) :].split(" #", 1)[0].strip()


def is_full_sha_use(uses: str, prefix: str) -> bool:
    ref = external_ref(uses, prefix)
    return ref is not None and FULL_SHA.fullmatch(ref) is not None


def cargo_tokens_compile(tokens: list[str]) -> bool:
    while tokens and tokens[0].startswith("+"):
        tokens.pop(0)
    if not tokens:
        return False
    if tokens[0] in PROBE_ARGS:
        return False
    subcommand = tokens[0]
    if subcommand in CARGO_NON_COMPILING:
        return False
    # Unknown cargo subcommands are cache-required by default. Cargo plugins can
    # invoke rustc internally, and silently exempting a new compiling subcommand
    # would break the invariant.
    return not (subcommand in {"package", "publish"} and "--no-verify" in tokens[1:])


SHELL_BOUNDARY = {";", "&&", "||", "|", "&"}
CONTROL_PREFIX = {"if", "then", "do", "while", "until", "!", "command"}
ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=")


def shell_segment_compiles(tokens: list[str]) -> bool:
    while tokens and (tokens[0] in CONTROL_PREFIX or ASSIGNMENT_RE.match(tokens[0])):
        tokens.pop(0)
    if not tokens:
        return False

    if tokens[0] == "env":
        tokens.pop(0)
        while tokens:
            token = tokens[0]
            if token in {"-u", "--unset"} and len(tokens) >= 2:
                del tokens[:2]
                continue
            if token.startswith("-") or ASSIGNMENT_RE.match(token):
                tokens.pop(0)
                continue
            break
    if not tokens:
        return False

    if tokens[:2] == ["rustup", "run"] and len(tokens) >= 4:
        tokens = tokens[3:]
    if not tokens:
        return False

    command = tokens[0]
    args = tokens[1:]
    if command == "cargo":
        return cargo_tokens_compile(args)
    if command in {"rustc", "rustdoc", "clippy-driver"}:
        return bool(args) and args[0] not in PROBE_ARGS
    return False


def shell_line_compiles(line: str) -> bool:
    try:
        lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        lexer.commenters = "#"
        tokens = list(lexer)
    except ValueError:
        # Fall back only for unmistakable compiler command spellings when shell
        # quoting is malformed.
        return bool(
            re.search(
                r"(?:^|[;&|]\s*)(?:cargo|rustc|rustdoc|clippy-driver)(?:\s|\+)", line
            )
        )

    segment: list[str] = []
    for token in [*tokens, ";"]:
        if token in SHELL_BOUNDARY or (token and set(token) <= {";", "&", "|"}):
            if shell_segment_compiles(segment):
                return True
            segment = []
        else:
            segment.append(token)
    return False


def run_mentions_rust(run: str) -> bool:
    heredoc_terminator: str | None = None
    for raw_line in run.splitlines():
        stripped = raw_line.strip()
        if heredoc_terminator is not None:
            if stripped == heredoc_terminator:
                heredoc_terminator = None
            continue
        if not stripped or stripped.startswith("#"):
            continue
        heredoc = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", stripped)
        if heredoc is not None:
            heredoc_terminator = heredoc.group(1)
        # Strip the ordinary unquoted shell-comment form. Quoted '#' is unusual
        # in compiler command lines; keeping this simple avoids pretending to be
        # a full shell parser.
        line = re.sub(r"\s+#.*$", "", stripped)
        if shell_line_compiles(line):
            return True
    return False


SHELL_INTERPRETERS = {"bash", "sh", "dash", "zsh", "ksh"}
SCRIPT_CONTEXT = {"exec", "command", "time", "nohup"}
DYNAMIC_PATH = re.compile(r"[$*?\x60]")


def shell_commands(source: str) -> list[list[str]]:
    commands: list[list[str]] = []
    terminator: str | None = None
    array_assignment = False
    shell_stdin = False
    stdin_lines: list[str] = []
    case_depth = 0
    for raw_line in source.replace("\\\n", "").splitlines():
        line = raw_line.strip()
        if re.match(r"^case\s+.+\s+in$", line):
            case_depth += 1
            continue
        if case_depth and line == "esac":
            case_depth -= 1
            continue
        if case_depth:
            arm = re.match(r"^[^()]*\)\s*(.*)$", line)
            if arm:
                # Ignore the pattern, but inspect commands after it.
                line = arm.group(1).strip()
                if not line:
                    continue
        if array_assignment:
            if line.startswith(")"):
                array_assignment = False
            continue
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=\(\s*", line):
            array_assignment = True
            continue
        if terminator is not None:
            if line == terminator:
                if shell_stdin:
                    commands.extend(shell_commands("\n".join(stdin_lines)))
                terminator = None
                shell_stdin = False
                stdin_lines.clear()
            elif shell_stdin:
                stdin_lines.append(raw_line)
            continue
        if not line or line.startswith("#"):
            continue
        heredoc = re.search(r"<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?", line)
        if heredoc is not None:
            terminator = heredoc.group(1)
            shell_stdin = bool(re.match(r"^(?:bash|sh|dash|zsh|ksh)\b", line))
        try:
            lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|")
            lexer.whitespace_split = True
            lexer.commenters = "#"
            tokens = list(lexer)
        except ValueError:
            if shell_line_compiles(line):
                commands.append(["cargo", "build"])
            continue
        segment: list[str] = []
        for token in [*tokens, ";"]:
            if token in SHELL_BOUNDARY or (token and set(token) <= {";", "&", "|"}):
                if segment:
                    commands.append(segment)
                segment = []
            else:
                segment.append(token)
    return commands


def normalized_command(tokens: list[str]) -> list[str]:
    tokens = tokens.copy()
    while tokens and (
        tokens[0] in CONTROL_PREFIX | SCRIPT_CONTEXT or ASSIGNMENT_RE.match(tokens[0])
    ):
        tokens.pop(0)
    if tokens and tokens[0] == "env":
        tokens.pop(0)
        while tokens:
            if tokens[0] in {"-u", "--unset"} and len(tokens) > 1:
                del tokens[:2]
            elif tokens[0].startswith("-") or ASSIGNMENT_RE.match(tokens[0]):
                tokens.pop(0)
            else:
                break
    if tokens and tokens[0] == "sudo":
        tokens.pop(0)
        while tokens and tokens[0].startswith("-"):
            tokens.pop(0)
    return tokens


def repo_path(root: Path, cwd: Path, value: str) -> Path | None:
    if DYNAMIC_PATH.search(value) or value.startswith("~") or not value:
        return None
    resolved = (Path(value) if Path(value).is_absolute() else cwd / value).resolve()
    return resolved if resolved.is_relative_to(root) else None


def script_target(tokens: list[str]) -> tuple[str | None, str | None]:
    if not tokens:
        return None, None
    command, *args = tokens
    if command in SHELL_INTERPRETERS:
        if any(arg.startswith("<<") for arg in args):
            return None, None
        index = 0
        reads_stdin = False
        while index < len(args):
            arg = args[index]
            if arg == "--":
                index += 1
                break
            if arg.startswith("-") and "c" in arg[1:] and not arg.startswith("--"):
                return None, args[index + 1] if index + 1 < len(args) else ""
            if arg in {"-o", "-O", "--rcfile", "--init-file"} or (
                arg.startswith("-") and "o" in arg[1:] and not arg.startswith("--")
            ):
                index += 2
                continue
            if arg.startswith("-"):
                # POSIX sh/bash -s reads the program from stdin. Arguments
                # after `--` are positional parameters, not local scripts.
                # A combined short option such as `-es` has the same meaning.
                if not arg.startswith("--") and "s" in arg[1:]:
                    reads_stdin = True
                index += 1
                continue
            break
        if reads_stdin:
            return None, None
        return (args[index], None) if index < len(args) else (None, None)
    if command in {"source", "."}:
        return (args[0], None) if args else (None, None)
    if command.startswith(("./", "../", "/")) or command.endswith((".sh", ".bash")):
        return command, None
    if (
        "/" in command
        and not any(ch in command for ch in ":*?[]()=$")
        and not any(ch.isspace() for ch in command)
    ):
        return command, None
    return None, None


def script_is_shell(path: Path) -> bool:
    if path.suffix in {".sh", ".bash"}:
        return True
    try:
        with path.open(encoding="utf-8", errors="replace") as stream:
            first = stream.readline().lower()
    except OSError:
        return False
    return first.startswith("#!") and any(
        re.search(r"(?:/|[ ])" + name + r"(?:\s|$)", first)
        for name in SHELL_INTERPRETERS
    )


def inspect_shell_source(
    source: str,
    root: Path,
    initial_cwd: Path,
    active: set[tuple[Path, Path]],
) -> tuple[bool, set[str]]:
    found = run_mentions_rust(source)
    unresolved: set[str] = set()
    cwd = initial_cwd
    for segment in shell_commands(source):
        tokens = normalized_command(segment)
        if not tokens:
            continue
        if shell_segment_compiles(tokens.copy()):
            found = True
            continue
        if tokens[0] == "cd" and len(tokens) >= 2:
            destination = repo_path(root, cwd, tokens[1])
            cwd = (
                destination
                if destination is not None and destination.is_dir()
                else root / "__unresolved_working_directory__"
            )
            continue
        script, inline = script_target(tokens)
        if inline is not None:
            if inline.lstrip().startswith("$") or chr(96) in inline:
                unresolved.add("unresolved dynamic shell -c program")
            nested, unknown = inspect_shell_source(inline, root, cwd, active)
            found |= nested
            unresolved.update(unknown)
        if script is None:
            continue
        path = repo_path(root, cwd, script)
        if path is None or not path.is_file():
            unresolved.add(f"unresolved local shell script: {script}")
            continue
        if tokens[0] not in {"source", "."} and not script_is_shell(path):
            continue
        key = (path, cwd)
        if key in active:
            continue
        active.add(key)
        try:
            nested, unknown = inspect_shell_source(
                path.read_text(encoding="utf-8", errors="replace"), root, cwd, active
            )
            found |= nested
            unresolved.update(unknown)
        except OSError:
            unresolved.add(f"unreadable local shell script: {script}")
        finally:
            active.remove(key)
    return found, unresolved


def working_directory(
    root: Path, job: dict[str, Any], step: dict[str, Any]
) -> Path | None:
    defaults = job.get("defaults")
    run_defaults = defaults.get("run") if isinstance(defaults, dict) else None
    default = (
        run_defaults.get("working-directory")
        if isinstance(run_defaults, dict)
        else None
    )
    value = step.get("working-directory", default)
    return (
        root
        if value is None
        else repo_path(root, root, value)
        if isinstance(value, str)
        else None
    )


def step_mentions_rust(step: object) -> bool:
    if not isinstance(step, dict):
        return False
    run = step.get("run")
    if isinstance(run, str) and run_mentions_rust(run):
        return True
    uses = step.get("uses")
    if not isinstance(uses, str):
        return False
    lowered = uses.lower()
    if uses.startswith("./"):
        # Local Rust policy/actions are Rust work even if the actual Cargo call
        # is nested in the composite action.
        return any(
            token in lowered
            for token in ("rust-strict", "cargo-build", "cargo-test", "clippy")
        )
    if lowered.startswith("actions-rs/cargo@"):
        with_args = step.get("with")
        command = (
            str(with_args.get("command", "")) if isinstance(with_args, dict) else ""
        )
        args = str(with_args.get("args", "")) if isinstance(with_args, dict) else ""
        try:
            tokens = [command, *shlex.split(args)] if command else []
        except ValueError:
            return True
        return cargo_tokens_compile(tokens)
    return any(lowered.startswith(prefix) for prefix in RUST_COMPILE_ACTIONS)


def canonical_step_kind(uses: str) -> str | None:
    # Relative actions can be supplied by the caller and need not be the
    # trusted implementation. Only immutable, externally pinned provider
    # actions can satisfy the fleet's cache invariant.
    if is_full_sha_use(uses, CANONICAL_SETUP):
        return "setup"
    if is_full_sha_use(uses, CANONICAL_FINALIZE):
        return "finalize"
    return None


def inspect_job(
    path: Path, job_name: str, job: object, strict_ref: str | None, root: Path
) -> list[str]:
    if not isinstance(job, dict):
        return []
    violations: list[str] = []
    job_uses = job.get("uses")
    if isinstance(job_uses, str):
        if job_uses.startswith(CANONICAL_WORKFLOW):
            if not is_full_sha_use(job_uses, CANONICAL_WORKFLOW):
                violations.append(
                    f"{path}:{job_name}: shared Rust CI ref must be a full commit SHA"
                )
            return violations
        if job_uses.startswith(STRICT_WORKFLOW):
            ref = external_ref(job_uses, STRICT_WORKFLOW)
            if ref is None or not FULL_SHA.fullmatch(ref):
                violations.append(
                    f"{path}:{job_name}: strict Rust workflow ref must be a full commit SHA"
                )
            elif strict_ref is not None and ref != strict_ref:
                violations.append(
                    f"{path}:{job_name}: strict Rust workflow uses {ref[:12]}, "
                    f"but the executing gate is {strict_ref[:12]}"
                )
            return violations
        return violations

    steps = job.get("steps")
    if not isinstance(steps, list):
        return violations

    rust_indices: list[int] = []
    unresolved_by_step: dict[int, set[str]] = {}
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        known = step_mentions_rust(step)
        run = step.get("run")
        if isinstance(run, str):
            cwd = working_directory(root, job, step)
            if cwd is None:
                if "./" in run or ".sh" in run:
                    unresolved_by_step[index] = {
                        "dynamic working-directory for shell script invocation"
                    }
            else:
                indirect, unresolved = inspect_shell_source(run, root, cwd, set())
                known |= indirect
                if unresolved:
                    unresolved_by_step[index] = unresolved
        if known or index in unresolved_by_step:
            rust_indices.append(index)
    setup_indices: list[int] = []
    finalize_indices: list[int] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            continue
        uses = step.get("uses")
        if not isinstance(uses, str):
            continue
        kind = canonical_step_kind(uses)
        if kind == "setup":
            setup_indices.append(index)
        elif kind == "finalize":
            finalize_indices.append(index)
        if uses.lower().startswith("swatinem/rust-cache@"):
            violations.append(
                f"{path}:{job_name}: Swatinem/rust-cache is forbidden; use canonical sccache"
            )

    if unresolved_by_step and not setup_indices:
        violations.extend(
            f"{path}:{job_name}: step {index}: {reason}; canonical sccache required"
            for index, unknowns in sorted(unresolved_by_step.items())
            for reason in sorted(unknowns)
        )

    if not rust_indices:
        return violations

    first_rust = min(rust_indices)
    last_rust = max(rust_indices)
    if not setup_indices:
        violations.append(
            f"{path}:{job_name}: Rust job is missing canonical setup-sccache"
        )
    elif min(setup_indices) > first_rust:
        violations.append(f"{path}:{job_name}: setup-sccache runs after Rust tooling")

    if not finalize_indices:
        violations.append(
            f"{path}:{job_name}: Rust job is missing canonical finalize-sccache"
        )
    elif max(finalize_indices) < last_rust:
        violations.append(
            f"{path}:{job_name}: finalize-sccache runs before the last Rust tooling step"
        )
    else:
        for index in finalize_indices:
            step = steps[index]
            if isinstance(step, dict) and str(step.get("if", "")).strip() != "always()":
                violations.append(
                    f"{path}:{job_name}: finalize-sccache must use if: always()"
                )

    return violations


def inspect_root(root: Path, strict_ref: str | None = None) -> list[str]:
    workflows = root / ".github" / "workflows"
    if not workflows.is_dir():
        return []
    violations: list[str] = []
    for path in sorted((*workflows.glob("*.yml"), *workflows.glob("*.yaml"))):
        try:
            data = yaml.safe_load(path.read_text())
        except yaml.YAMLError as exc:
            violations.append(f"{path}: invalid YAML: {exc}")
            continue
        if not isinstance(data, dict):
            continue
        jobs = data.get("jobs")
        if not isinstance(jobs, dict):
            continue
        for name, job in jobs.items():
            violations.extend(
                inspect_job(path.relative_to(root), str(name), job, strict_ref, root)
            )
    return violations


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--strict-ref", help="Expected rust-skills2 strict workflow SHA"
    )
    args = parser.parse_args()
    root = args.root.resolve()
    violations = inspect_root(root, args.strict_ref or None)
    if violations:
        print("ci-workflows: Rust CI sccache policy violations:")
        for violation in violations:
            print(f"- {violation}")
        return 1
    print("ci-workflows: every detected Rust CI job uses canonical sccache")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
