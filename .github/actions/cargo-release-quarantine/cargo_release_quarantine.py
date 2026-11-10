#!/usr/bin/env python3
"""Enforce minimum crates.io publication age across tracked Cargo lockfiles."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import operator
import subprocess
import sys
import tomllib
import urllib.parse
import urllib.request
from pathlib import Path
from typing import NotRequired, TypedDict, cast


class LockPackage(TypedDict):
    name: str
    version: str
    source: NotRequired[str]


class CrateVersion(TypedDict):
    num: str
    created_at: str


class CratesPayload(TypedDict):
    versions: list[CrateVersion]


CRATES_IO_MARKERS = ("crates.io-index", "index.crates.io")
QUARANTINED_EXIT = 10
_cache: dict[str, dict[str, CrateVersion]] = {}


def git_show(ref: str, path: str) -> bytes:
    return subprocess.check_output(["git", "show", f"{ref}:{path}"])


def git_baseline_is_valid(ref: str) -> None:
    subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def list_tracked_lockfiles(ref: str | None = None) -> set[str]:
    if ref is None:
        cmd = ["git", "ls-files", "--cached", "-z"]
    else:
        cmd = ["git", "ls-tree", "-r", "--name-only", "-z", ref]
    files = subprocess.check_output(cmd).decode("utf-8", errors="surrogateescape")
    return {
        path
        for path in files.split("\0")
        if path == "Cargo.lock" or path.endswith("/Cargo.lock")
    }


def load_lock(raw: bytes) -> list[LockPackage]:
    return cast(list[LockPackage], tomllib.loads(raw.decode()).get("package", []))


def key(pkg: LockPackage) -> tuple[str, str, str | None]:
    return pkg["name"], pkg["version"], pkg.get("source")


def is_crates_io(pkg: LockPackage) -> bool:
    source = pkg.get("source") or ""
    return source.startswith("registry+") and any(
        marker in source for marker in CRATES_IO_MARKERS
    )


def crate_versions(name: str) -> dict[str, CrateVersion]:
    if name in _cache:
        return _cache[name]
    req = urllib.request.Request(
        "https://crates.io/api/v1/crates/" + urllib.parse.quote(name, safe=""),
        headers={
            "Accept": "application/json",
            "User-Agent": "codeandsolder-ci-release-quarantine/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        payload = cast(CratesPayload, json.load(response))
    versions = {item["num"]: item for item in payload.get("versions", [])}
    _cache[name] = versions
    return versions


def publication_time(pkg: LockPackage) -> dt.datetime | None:
    info = crate_versions(pkg["name"]).get(pkg["version"])
    value = info.get("created_at") if info else None
    return dt.datetime.fromisoformat(value) if value else None


def selected_lockfiles(ref: str, selector: str) -> tuple[set[str], set[str]]:
    if selector != "auto":
        # Explicit path selection is useful for CI scripts that inspect a
        # particular lockfile, including generated test fixtures.
        try:
            git_show(ref, selector)
        except subprocess.CalledProcessError:
            before: set[str] = set()
        else:
            before = {selector}
        after: set[str] = {selector} if Path(selector).is_file() else set()
        return before, after

    before = list_tracked_lockfiles(ref)
    tracked = list_tracked_lockfiles()
    after = {path for path in tracked if Path(path).is_file()}
    for path in sorted(tracked):
        if Path(path).is_symlink():
            raise ValueError(f"refusing symlinked tracked lockfile {path}")

    return before, after


def compare_lockfiles(ref: str, selector: str) -> list[LockPackage]:
    """Return new crate versions across the union of all tracked lockfiles."""
    before_files, after_files = selected_lockfiles(ref, selector)

    if selector != "auto" and before_files - after_files:
        raise ValueError(
            f"explicitly selected lockfile {selector} was removed from this revision"
        )

    for removed in sorted(before_files - after_files):
        manifest = Path(removed).with_name("Cargo.toml")
        if manifest.is_file():
            raise ValueError(
                f"tracked lockfile {removed} was removed but workspace manifest "
                f"{manifest} still exists; restore the lockfile or remove the "
                "workspace explicitly"
            )

    before = {
        key(pkg)
        for file in sorted(before_files)
        for pkg in load_lock(git_show(ref, file))
        if is_crates_io(pkg)
    }

    after: dict[tuple[str, str, str | None], LockPackage] = {}
    for file in sorted(after_files):
        for pkg in load_lock(Path(file).read_bytes()):
            if is_crates_io(pkg):
                after[key(pkg)] = pkg
    changed = [pkg for k, pkg in after.items() if k not in before]
    return sorted(changed, key=operator.itemgetter("name", "version"))


def quarantine(ref: str, selector: str, hours: int) -> int:
    git_baseline_is_valid(ref)
    changed = compare_lockfiles(ref, selector)
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(hours=hours)
    blocked: list[str] = []
    for pkg in changed:
        try:
            when = publication_time(pkg)
        except (OSError, ValueError, KeyError) as err:
            blocked.append(
                f"{pkg['name']} {pkg['version']}: crates.io lookup failed: {err}"
            )
            continue
        if when is None:
            blocked.append(
                f"{pkg['name']} {pkg['version']}: missing authoritative crates.io publication time"
            )
        elif when > cutoff:
            blocked.append(
                f"{pkg['name']} {pkg['version']}: published {when.isoformat()}, "
                f"younger than {hours}h"
            )

    if blocked:
        print("Cargo release-age quarantine is still active:", file=sys.stderr)
        for item in blocked:
            print(f"- {item}", file=sys.stderr)
        return QUARANTINED_EXIT

    print(
        "Cargo release-age quarantine passed for "
        f"{len(changed)} newly introduced crates.io package versions "
        f"across {selector if selector != 'auto' else 'all tracked Cargo.lock files'}."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument(
        "--lockfile",
        default="auto",
        help="'auto' scans all tracked Cargo.lock files; otherwise one repository-relative path",
    )
    args = parser.parse_args()

    if args.hours < 0:
        parser.error("--hours must be non-negative")

    try:
        return quarantine(args.base_ref, args.lockfile, args.hours)
    except (ValueError, subprocess.CalledProcessError, tomllib.TOMLDecodeError) as err:
        print(
            f"Cargo release-age quarantine cannot validate lockfiles: {err}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
