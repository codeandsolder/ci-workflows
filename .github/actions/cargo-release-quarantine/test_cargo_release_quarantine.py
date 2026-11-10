"""Behavior tests for the shared crates.io publication-age policy."""

from __future__ import annotations

import datetime as dt
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_SCRIPT = Path(__file__).with_name("cargo_release_quarantine.py")
_SPEC = importlib.util.spec_from_file_location("cargo_quarantine", _SCRIPT)
assert _SPEC is not None and _SPEC.loader is not None
quarantine = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(quarantine)

_SOURCE = "registry+https://github.com/rust-lang/crates.io-index"


def make_lock(*packages: tuple[str, str]) -> str:
    out = ["version = 4"]
    for name, version in packages:
        out.extend(
            [
                "",
                "[[package]]",
                f'name = "{name}"',
                f'version = "{version}"',
                f'source = "{_SOURCE}"',
            ]
        )
    return "\n".join(out) + "\n"


class QuarantineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cargo-quarantine-test-")
        self.original = Path.cwd()
        os.chdir(self.temp.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Quarantine Test")
        self.git("config", "user.email", "quarantine-test@example.invalid")

    def tearDown(self) -> None:
        os.chdir(self.original)
        self.temp.cleanup()

    @staticmethod
    def git(*args: str) -> None:
        subprocess.run(["git", *args], check=True, capture_output=True)

    @staticmethod
    def write(path: str, content: str) -> None:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")

    def baseline(self) -> str:
        self.git("add", "-A")
        self.git("commit", "-qm", "baseline")
        return subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()

    def test_autodiscovers_root_and_nested_workspaces(self) -> None:
        self.write("Cargo.toml", "[workspace]\nmembers=[]\n")
        self.write("Cargo.lock", make_lock(("serde", "1.0.0")))
        self.write(
            "workloads/foo/Cargo.toml", "[package]\nname='foo'\nversion='0.1.0'\n"
        )
        self.write("workloads/foo/Cargo.lock", make_lock(("flate2", "1.0.0")))
        ref = self.baseline()
        self.write(
            "workloads/foo/Cargo.lock",
            make_lock(("flate2", "1.0.0"), ("zstd", "0.9.2")),
        )
        self.write(
            "workloads/bar/Cargo.lock", make_lock(("zstd", "0.9.2"), ("serde", "1.0.0"))
        )
        self.git("add", "-A")
        changed = quarantine.compare_lockfiles(ref, "auto")
        self.assertEqual(
            [(p["name"], p["version"]) for p in changed], [("zstd", "0.9.2")]
        )

    def test_moved_lockfile_does_not_requarantine_same_version(self) -> None:
        self.write("a/Cargo.toml", "[workspace]\n")
        self.write("a/Cargo.lock", make_lock(("serde", "1.0.0")))
        ref = self.baseline()
        Path("a/Cargo.lock").unlink()
        Path("a/Cargo.toml").unlink()
        self.write("b/Cargo.toml", "[workspace]\n")
        self.write("b/Cargo.lock", make_lock(("serde", "1.0.0")))
        self.git("add", "-A")
        self.assertEqual(quarantine.compare_lockfiles(ref, "auto"), [])

    def test_entire_deleted_workspace_is_allowed(self) -> None:
        self.write("package/Cargo.toml", "[workspace]\n")
        self.write("package/Cargo.lock", make_lock(("serde", "1.0.0")))
        ref = self.baseline()
        Path("package/Cargo.toml").unlink()
        Path("package/Cargo.lock").unlink()
        self.git("add", "-A")
        self.assertEqual(quarantine.compare_lockfiles(ref, "auto"), [])

    def test_removing_lockfile_from_live_workspace_is_rejected(self) -> None:
        self.write("Cargo.toml", "[workspace]\n")
        self.write("Cargo.lock", make_lock(("serde", "1.0.0")))
        ref = self.baseline()
        Path("Cargo.lock").unlink()
        self.git("add", "-A")
        with self.assertRaisesRegex(ValueError, "still exists"):
            quarantine.compare_lockfiles(ref, "auto")

    def test_removing_explicitly_selected_lockfile_is_rejected(self) -> None:
        self.write("record.txt", make_lock(("serde", "1.0.0")))
        ref = self.baseline()
        Path("record.txt").unlink()
        self.git("add", "-A")
        with self.assertRaisesRegex(ValueError, "explicitly selected"):
            quarantine.compare_lockfiles(ref, "record.txt")

    def test_no_tracked_lockfiles_is_a_noop(self) -> None:
        self.write("README.md", "hello")
        ref = self.baseline()
        self.assertEqual(quarantine.compare_lockfiles(ref, "auto"), [])
        self.assertEqual(quarantine.quarantine(ref, "auto", 72), 0)

    def test_symlinked_lockfile_is_rejected(self) -> None:
        self.write("Cargo.toml", "[workspace]\n")
        self.write("target.lock", make_lock(("serde", "1.0.0")))
        Path("Cargo.lock").symlink_to("target.lock")
        ref = self.baseline()
        with self.assertRaisesRegex(ValueError, "symlinked"):
            quarantine.compare_lockfiles(ref, "auto")

    def test_recent_version_is_blocked_and_old_version_accepted(self) -> None:
        self.write("Cargo.toml", "[workspace]\n")
        self.write("Cargo.lock", make_lock(("serde", "1.0.0")))
        ref = self.baseline()
        self.write("Cargo.lock", make_lock(("serde", "1.0.1")))
        now = dt.datetime.now(dt.UTC)
        with patch.object(quarantine, "publication_time", return_value=now):
            self.assertEqual(
                quarantine.quarantine(ref, "auto", 72), quarantine.QUARANTINED_EXIT
            )
        with patch.object(
            quarantine, "publication_time", return_value=now - dt.timedelta(days=8)
        ):
            self.assertEqual(quarantine.quarantine(ref, "auto", 72), 0)

    def test_missing_metadata_fails_closed(self) -> None:
        self.write("Cargo.toml", "[workspace]\n")
        self.write("Cargo.lock", make_lock(("serde", "1.0.0")))
        ref = self.baseline()
        self.write("Cargo.lock", make_lock(("serde", "1.0.1")))
        with patch.object(quarantine, "publication_time", return_value=None):
            self.assertEqual(
                quarantine.quarantine(ref, "auto", 72), quarantine.QUARANTINED_EXIT
            )
        with patch.object(
            quarantine, "publication_time", side_effect=OSError("unreachable")
        ):
            self.assertEqual(
                quarantine.quarantine(ref, "auto", 72), quarantine.QUARANTINED_EXIT
            )


if __name__ == "__main__":
    unittest.main()
