"""Regression fixtures for the shared workflow supersession policy."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / ".github/actions/workflow-concurrency-policy/check.py"
spec = importlib.util.spec_from_file_location("workflow_concurrency_check", SCRIPT)
assert spec is not None and spec.loader is not None
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

GROUP = "${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}"
CANCEL = "${{ github.event_name == 'pull_request' }}"


def check(files: dict[str, str], expected: str | None = None) -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        workflows = root / ".github/workflows"
        workflows.mkdir(parents=True)
        for name, source in files.items():
            (workflows / name).write_text(source)
        errors = policy.inspect_root(root)
        if expected is None:
            assert not errors, errors
        else:
            assert any(expected in error for error in errors), errors


def workflow(
    trigger: str = "  pull_request:\n  push:\n    branches: [main]\n",
    group: str = GROUP,
    cancel: str = CANCEL,
    name: str = "Check",
) -> str:
    return (
        f"name: {name}\non:\n{trigger}concurrency:\n"
        f"  group: {group}\n  cancel-in-progress: {cancel}\n"
        "jobs:\n  rust:\n    runs-on: ubuntu-24.04\n    steps:\n"
        "      - run: echo pass\n"
    )


# Correct forms, ordinary PR and PR target, YAML anchors, mixed events,
# static workflow-specific prefixes, and PR-close cleanup.
check({"ci.yml": workflow()})
check({"ci.yaml": workflow()})
check({"ci.yml": workflow(trigger="  pull_request:\n", cancel="true")})
check({"ci.yml": workflow(trigger="  pull_request_target:\n", cancel="true")})
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n",
            group="${{ github.workflow }}-${{ github.event.pull_request.number }}",
            cancel="true",
        )
    }
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n",
            group="${{ github.workflow }}-${{ github.ref }}",
            cancel="true",
        )
    }
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n  pull_request_target:\n",
            cancel="${{ github.event_name == 'pull_request' || github.event_name == 'pull_request_target' }}",
        )
    }
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request_target:\n",
            group="ci-${{ github.event.pull_request.number }}",
            cancel="${{ github.event_name == 'pull_request_target' }}",
        )
    }
)
check(
    {
        "ci.yml": workflow(
            trigger="  push:\n    branches: [main]\n", group="", cancel="false"
        )
    }
)
check({"ci.yml": workflow(trigger="  workflow_call:\n", group="", cancel="false")})
check({"ci.yml": workflow(trigger="  workflow_dispatch:\n", group="", cancel="false")})
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n    types: [closed]\n", group="", cancel="false"
        )
    }
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n",
            cancel="${{ (github.event_name == 'pull_request') }}",
        )
    }
)
check(
    {
        "ci.yml": workflow(
            group="ci-${{ github.event.pull_request.number || github.ref }}", name="CI"
        ),
        "lint.yml": workflow(
            group="lint-${{ github.event.pull_request.number || github.ref }}",
            name="Lint",
        ),
    }
)
check(
    {
        "ci.yml": """
name: CI
on:
  pull_request:
x-concurrency: &policy
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
concurrency: *policy
jobs:
  build:
    runs-on: ubuntu-24.04
"""
    }
)

# Incorrect: workflow-level cancellation is absent, job-only is not enough;
# absent uniqueness, cross-workflow group collision, incorrect PR target ref,
# ignoring some PR events, collapsing all push events, unsupported YAML.
check(
    {"ci.yml": "on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n"},
    "requires top-level",
)
check({"ci.yml": workflow(group="test", cancel="true")}, "lacks a PR-unique key")
check({"ci.yml": workflow(group="", cancel="true")}, "group must be nonempty")
check({"ci.yml": workflow(cancel="false")}, "cancel-in-progress must cancel")
check(
    {"ci.yml": workflow(cancel="${{ github.event_name == 'push' }}")},
    "cancel-in-progress must cancel",
)
check(
    {
        "ci.yml": workflow(
            cancel="${{ github.event_name == 'pull_request' && github.event.action == 'synchronize' }}"
        )
    },
    "cancel-in-progress must cancel",
)
check(
    {
        "ci.yml": workflow(
            group="${{ github.event.pull_request.number }}", cancel="true"
        )
    },
    "requires non-PR fallback",
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request_target:\n",
            group="${{ github.workflow }}-${{ github.ref }}",
            cancel="true",
        )
    },
    "pull_request_target group",
)
check(
    {"ci.yml": workflow(trigger="  pull_request:\n  workflow_call:\n")},
    "workflow_call mixed",
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n  pull_request_target:\n",
            group="${{ github.workflow }}-${{ github.event.pull_request.number }}",
            cancel="true",
        )
    },
    "separate event-specific groups",
)
check(
    {
        "ci.yml": workflow(
            group="${{ github.workflow }}-${{ github.head_ref }}", cancel="true"
        )
    },
    "lacks a PR-unique key",
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n",
            group="${{ github.workflow }}-${{ github.ref }}",
            cancel="true",
            name="Same Name",
        ),
        "also.yml": workflow(
            trigger="  pull_request:\n",
            group="${{ github.workflow }}-${{ github.ref }}",
            cancel="true",
            name="Same Name",
        ),
    },
    "collides",
)
check(
    {
        "ci.yml": "on: [pull_request]\nconcurrency:\n  group: test\n  cancel-in-progress: false\n"
    },
    "lacks a PR-unique key",
)
check({"ci.yml": "on: [pull_request\n"}, "invalid YAML")
check(
    {
        "ci.yml": """
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    concurrency:
      group: ${{ github.workflow }}-${{ github.ref }}
      cancel-in-progress: true
"""
    },
    "requires top-level",
)
check(
    {
        "ci.yml": workflow(
            trigger="  pull_request:\n    types: [closed, synchronize]\n",
            group="",
            cancel="false",
        )
    },
    "group must be nonempty",
)

print("Shared CI: all workflow concurrency policy fixtures passed")

# Proven-correct upstream semantics must be recognized, not force-migrated
# just because their expressions differ from our recommended template.
check(
    {
        "one-shot.yml": workflow(
            trigger="  pull_request:\n    types: [opened]\n",
            group="bonk-${{ github.event.pull_request.number || github.event.issue.number || github.ref }}",
            cancel="false",
        )
    }
)
check(
    {
        "oxc.yml": workflow(
            trigger="  pull_request:\n  push:\n    branches: [main]\n  merge_group:\n",
            group="${{ github.workflow }}-${{ github.ref_name }}-${{ github.event.pull_request.number || github.sha }}",
            cancel="${{ github.ref_name != 'main' }}",
        )
    }
)
check(
    {
        "monitor.yml": workflow(
            trigger="  pull_request:\n    types: [labeled]\n  issue_comment:\n    types: [created]\n",
            group="monitor-${{ github.event.pull_request.number || github.event.issue.number }}",
            cancel="true",
        )
    }
)
check(
    {
        "security.yml": workflow(
            trigger="  pull_request:\n  push:\n",
            group="security-${{ github.event.pull_request.number || github.sha }}",
            cancel="${{ github.ref_name != 'main' }}",
        )
    }
)
check(
    {
        "wrong.yml": workflow(
            trigger="  pull_request_target:\n",
            group="security-${{ github.event.pull_request.number }}",
            cancel="${{ github.ref_name != 'main' }}",
        )
    },
    "cancel-in-progress must cancel",
)
check(
    {
        "fake.yml": workflow(
            trigger="  pull_request:\n",
            group="security-${{ 'github.ref' }}",
            cancel="true",
        )
    },
    "lacks a PR-unique key",
)

print("Shared CI: generalized upstream workflow cases PASS")
