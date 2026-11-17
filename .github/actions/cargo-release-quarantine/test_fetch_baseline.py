"""Git transport regressions for the Cargo quarantine baseline fetch."""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

_FETCH = Path(__file__).with_name("fetch_baseline.sh")


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        check=True,
        text=True,
    )
    return result.stdout.strip()


def set_author(repo: Path) -> None:
    git(repo, "config", "user.name", "Quarantine Regression")
    git(repo, "config", "user.email", "quarantine@example.invalid")


class BaselineFetchTest(unittest.TestCase):
    def test_unreachable_historical_submodule_does_not_block_lockfile_baseline(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory(prefix="quarantine-fetch-") as directory:
            root = Path(directory)
            subsource = root / "subsource"
            subremote = root / "submodule.git"
            source = root / "source"
            remote = root / "super.git"
            checkout = root / "checkout"

            git(root, "init", "-q", "-b", "main", str(subsource))
            set_author(subsource)
            (subsource / "fixture.txt").write_text("fixture\n", encoding="utf-8")
            git(subsource, "add", "fixture.txt")
            git(subsource, "commit", "-qm", "available submodule revision")
            git(root, "clone", "--bare", "-q", str(subsource), str(subremote))

            git(root, "init", "-q", "-b", "main", str(source))
            set_author(source)
            git(
                source,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "-q",
                str(subremote),
                "resources",
            )
            git(source, "commit", "-qam", "caller with available resources")
            git(source, "branch", "head")

            # Only the *baseline* commit points at an unreachable gitlink;
            # the checked-out caller still has an initialized, valid submodule.
            unavailable = "f" * 40
            git(
                source,
                "update-index",
                "--cacheinfo",
                f"160000,{unavailable},resources",
            )
            git(source, "commit", "-qm", "historical unavailable submodule")
            baseline = git(source, "rev-parse", "HEAD")
            git(source, "checkout", "-q", "head")
            git(root, "clone", "--bare", "-q", str(source), str(remote))
            git(
                root,
                "clone",
                "-q",
                "--depth",
                "1",
                "-b",
                "head",
                f"file://{remote}",
                str(checkout),
            )
            git(
                checkout,
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "update",
                "--init",
                "-q",
                "resources",
            )
            git(checkout, "config", "fetch.recurseSubmodules", "on-demand")

            broken = subprocess.run(
                [
                    "git",
                    "-c",
                    "protocol.file.allow=always",
                    "fetch",
                    "--no-tags",
                    "origin",
                    baseline,
                ],
                cwd=checkout,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(broken.returncode, 0, broken.stdout)
            self.assertIn("not our ref", broken.stderr)

            fixed = subprocess.run(
                ["bash", str(_FETCH), baseline],
                cwd=checkout,
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(fixed.returncode, 0, fixed.stderr)
            git(checkout, "cat-file", "-e", f"{baseline}^{{commit}}")


if __name__ == "__main__":
    unittest.main()
