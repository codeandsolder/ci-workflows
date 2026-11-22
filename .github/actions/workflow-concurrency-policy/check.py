"""Require safe workflow concurrency and portable runner selection."""

from __future__ import annotations

import argparse
import itertools
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import yaml

PR_EVENTS = frozenset({"pull_request", "pull_request_target"})
GLOBAL_SNAPSHOT_DIRECTIVE = re.compile(
    r"(?m)^# ci-workflow-supersession: global-snapshot; ([^\n]{25,})\nconcurrency:[ \t]*$",
)


def triggers(doc: dict[str, Any]) -> dict[str, object]:
    value = doc.get("on")
    if isinstance(value, str):
        return {value: None}
    if isinstance(value, list):
        return {event: None for event in value if isinstance(event, str)}
    if isinstance(value, dict):
        return {
            key: settings for key, settings in value.items() if isinstance(key, str)
        }
    return {}


def needs_pr_cancellation(event: str, settings: object) -> bool:
    if event not in PR_EVENTS:
        return False
    if not isinstance(settings, dict):
        return True
    types = settings.get("types")
    # An opened-only, one-shot workflow does not re-run on subsequent PR
    # revisions, so there is no same-workflow supersession to configure.
    return not (isinstance(types, list) and set(types) in ({"closed"}, {"opened"}))


def cancels_all_prs(value: object, events: set[str]) -> bool:
    if value == "true":
        return True
    if not isinstance(value, str) or not (
        value.strip().startswith("${{") and value.strip().endswith("}}")
    ):
        return False
    expression = value.strip()[3:-2].strip()
    if expression.startswith("(") and expression.endswith(")"):
        expression = expression[1:-1].strip()
    clauses = {
        clause.strip().strip("() ").replace('"', "'")
        for clause in expression.split("||")
    }
    expected = {f"github.event_name == '{event}'" for event in events}
    if bool(clauses) and clauses == expected:
        return True
    # For pull_request (not pull_request_target), GitHub's ref_name is
    # NUMBER/merge, never the name of the default branch. Upstream workflows
    # often use this guard to preserve main and merge-queue checks.
    return events == {"pull_request"} and bool(
        re.fullmatch(r"github[.]ref_name[ ]*!=[ ]*['\"][^'\"]+['\"]", expression),
    )


def workflow_references(group: str) -> set[str]:
    """Find real GitHub context references inside expressions, not literals."""
    refs: set[str] = set()
    pattern = re.escape("$" + "{{") + r"\s*(.*?)\s*" + re.escape("}}")
    for body in re.findall(pattern, group, flags=re.DOTALL):
        # Context strings inside quoted constants are not dynamic references.
        unquoted = re.sub(r"\x27[^\x27]*\x27|\x22[^\x22]*\x22", "", body)
        refs.update(
            re.findall(r"(?<![A-Za-z0-9_.])github[.][A-Za-z_][A-Za-z0-9_.]*", unquoted),
        )
    return refs


def validate(
    path: Path,
    doc: dict[str, Any],
    events: dict[str, object],
    source: str,
) -> list[str]:
    relevant = {
        event
        for event, settings in events.items()
        if needs_pr_cancellation(event, settings)
    }
    if not relevant:
        return []
    problems = []
    concurrency = doc.get("concurrency")
    if not isinstance(concurrency, dict):
        return [f"{path}: PR-triggered workflow requires top-level concurrency"]
    group = concurrency.get("group")
    global_mode = GLOBAL_SNAPSHOT_DIRECTIVE.search(source) is not None
    if global_mode:
        if "workflow_call" in events:
            problems.append(
                f"{path}: global-snapshot cannot be combined with workflow_call",
            )
        # A workflow rebuilding *all* open-PR state may legitimately cancel
        # every prior run, including a run triggered by another PR or push.
        # Require a documented opt-in and the precise repository-wide group:
        # per-PR scoping would make concurrent rescan writers race each other.
        if group != "${{ github.workflow }}":
            problems.append(f"{path}: global-snapshot requires github.workflow group")
        if concurrency.get("cancel-in-progress") != "true":
            problems.append(
                f"{path}: global-snapshot requires unconditional cancellation",
            )
        return problems
    if not isinstance(group, str) or not group.strip():
        problems.append(f"{path}: concurrency.group must be nonempty")
    else:
        refs = workflow_references(group)
        has_number = "github.event.pull_request.number" in refs
        has_pr_ref = "github.ref" in refs or "github.ref_name" in refs
        if "pull_request_target" in relevant and not has_number:
            problems.append(
                f"{path}: pull_request_target group must include github.event.pull_request.number "
                "(github.ref names the target branch)",
            )
        elif not has_number and not has_pr_ref:
            problems.append(f"{path}: concurrency.group lacks a PR-unique key")
        if len(relevant) > 1 and "github.event_name" not in refs:
            problems.append(
                f"{path}: PR and PR-target events need separate event-specific groups",
            )
        non_pr = set(events) - PR_EVENTS
        fallback = {"github.ref", "github.ref_name", "github.sha", "github.run_id"}
        if non_pr - {
            "issue_comment",
            "pull_request_review_comment",
        } and not refs.intersection(fallback):
            problems.append(f"{path}: mixed-event group requires non-PR fallback")
        if non_pr.intersection(
            {"issue_comment", "pull_request_review_comment"},
        ) and not refs.intersection(
            {
                "github.event.issue.number",
                "github.event.pull_request.number",
                "github.run_id",
            },
        ):
            problems.append(f"{path}: comment-triggered group lacks issue/PR identity")
    if not cancels_all_prs(concurrency.get("cancel-in-progress"), relevant):
        problems.append(
            f"{path}: cancel-in-progress must cancel every PR revision "
            "(true or event-name PR-only condition)",
        )
    if "workflow_call" in events:
        problems.append(
            f"{path}: workflow_call mixed with PR triggers risks cancelling its caller; "
            "split reusable and event-triggered workflows",
        )
    return problems


# Identity labels belong to runner inventory, not job requirements. Capability
# labels (including licensed tools and dedicated benchmark hardware) remain
# legitimate; those are verified separately by runner inventory admission.
HOST_IDENTITIES = re.compile(r"(?i)(?<![A-Za-z0-9_.-])(?:acer|asus)(?![A-Za-z0-9_.-])")
HOST_INPUT = re.compile(
    r"(?<![A-Za-z0-9_.-])/(?:home/jan|srv/ci/toolchains|srv/scratch)(?:/|\b)"
)
MATRIX_REF = re.compile(r"\bmatrix\.([A-Za-z_][A-Za-z0-9_-]*)")


def scalar_strings(value: object) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from scalar_strings(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from scalar_strings(item)


def validate_portability(path: Path, doc: dict[str, Any]) -> list[str]:
    problems = []
    jobs = doc.get("jobs")
    if not isinstance(jobs, dict):
        return problems
    for name, job in jobs.items():
        if not isinstance(job, dict):
            continue
        # A reusable-workflow caller may expose the runner as an input.
        with_inputs = job.get("with")
        selectors = [job.get("runs-on")]
        if isinstance(with_inputs, dict):
            selectors.append(with_inputs.get("runner"))
        values = list(scalar_strings(selectors))
        referenced = {key for value in values for key in MATRIX_REF.findall(value)}
        matrix = job.get("strategy", {})
        matrix = matrix.get("matrix", {}) if isinstance(matrix, dict) else {}
        if isinstance(matrix, dict):
            for key in referenced:
                values.extend(scalar_strings(matrix.get(key)))
                for collection in ("include", "exclude"):
                    entries = matrix.get(collection, [])
                    if isinstance(entries, list):
                        for entry in entries:
                            if isinstance(entry, dict):
                                values.extend(scalar_strings(entry.get(key)))
        if any(HOST_IDENTITIES.search(value) for value in values):
            problems.append(
                f"{path}: job {name}: physical host selector; use a declared runner capability instead"
            )
        # Hard-coded user workspace or build-input paths in workflow execution
        # are not portable. Canonical system-level cache paths are not banned.
        paths = [doc.get("env"), job.get("env"), job.get("defaults")]
        for step in job.get("steps", []):
            if isinstance(step, dict):
                paths.extend(step.get(field) for field in ("env", "run", "with"))
        if any(HOST_INPUT.search(value) for value in scalar_strings(paths)):
            problems.append(
                f"{path}: job {name}: host-local build path; use runner temporary storage or a verified artifact"
            )
    return problems


def inspect_root(root: Path) -> list[str]:
    directory = root / ".github/workflows"
    if not directory.is_dir():
        return []
    problems: list[str] = []
    groups: dict[str, Path] = {}
    for path in sorted(directory.iterdir()):
        if path.suffix not in {".yml", ".yaml"} or not path.is_file():
            continue
        rel = path.relative_to(root)
        try:
            # BaseLoader preserves the Actions 'on' key, which YAML 1.1's
            # default boolean resolver would otherwise convert to True.
            source = path.read_text(encoding="utf8")
            doc = yaml.load(source, Loader=yaml.BaseLoader)
        except yaml.YAMLError as exc:
            problems.append(f"{rel}: invalid YAML: {exc}")
            continue
        if not isinstance(doc, dict):
            problems.append(f"{rel}: expected YAML mapping")
            continue
        events = triggers(doc)
        problems.extend(validate_portability(rel, doc))
        problems.extend(validate(rel, doc, events, source))
        if not any(itertools.starmap(needs_pr_cancellation, events.items())):
            continue
        concurrency = doc.get("concurrency")
        if not isinstance(concurrency, dict) or not isinstance(
            concurrency.get("group"),
            str,
        ):
            continue
        # GitHub scopes groups to repository, *not* workflow. A group template
        # using github.workflow can still collide if two files share a name.
        name = str(doc.get("name") or path.stem).casefold()
        template = concurrency["group"].strip().casefold()
        evaluated = template.replace("${{ github.workflow }}", name)
        if evaluated in groups:
            problems.append(
                f"{rel}: concurrency.group collides with {groups[evaluated]}",
            )
        else:
            groups[evaluated] = rel
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    args = parser.parse_args()
    problems = inspect_root(args.root.resolve())
    if problems:
        print("Shared CI: workflow policy failures:")
        for problem in problems:
            print("- " + problem)
        return 1
    print("Shared CI: workflows satisfy cancellation and portable runner policy")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
