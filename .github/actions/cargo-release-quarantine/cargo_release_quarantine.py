#!/usr/bin/env python3
"""Enforce a minimum age for newly introduced crates.io lockfile entries."""

from __future__ import annotations

import argparse
import datetime as dt
import json
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-ref", required=True)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("--lockfile", default="Cargo.lock")
    args = parser.parse_args()

    if args.hours < 0:
        parser.error("--hours must be non-negative")

    lockfile = Path(args.lockfile)
    try:
        previous_lock = git_show(args.base_ref, args.lockfile)
    except subprocess.CalledProcessError:
        # A missing file is legitimate, but an invalid/inaccessible baseline is not.
        subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", f"{args.base_ref}^{{commit}}"],
            check=True,
            stdout=subprocess.DEVNULL,
        )
        previous_lock = None

    # An Actions-only update introduces no crates, unless it has *removed* an
    # existing lockfile. That is never a valid way to bypass quarantine.
    if not lockfile.is_file():
        if previous_lock is not None:
            print(
                f"Cargo release-age quarantine failed: {args.lockfile} existed "
                "in the baseline but is missing in this revision.",
                file=sys.stderr,
            )
            return QUARANTINED_EXIT
        print(
            "Cargo release-age quarantine passed: no lockfile in either revision."
        )
        return 0

    before = {key(pkg) for pkg in load_lock(previous_lock)} if previous_lock else set()

    after = load_lock(lockfile.read_bytes())
    changed = [pkg for pkg in after if key(pkg) not in before and is_crates_io(pkg)]
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(hours=args.hours)

    blocked: list[str] = []
    for pkg in changed:
        when = publication_time(pkg)
        if when is None:
            blocked.append(
                f"{pkg['name']} {pkg['version']}: missing authoritative crates.io publication time"
            )
        elif when > cutoff:
            blocked.append(
                f"{pkg['name']} {pkg['version']}: published {when.isoformat()}, "
                f"younger than {args.hours}h"
            )

    if blocked:
        print("Cargo release-age quarantine is still active:", file=sys.stderr)
        for item in blocked:
            print(f"- {item}", file=sys.stderr)
        return QUARANTINED_EXIT

    print(
        f"Cargo release-age quarantine passed for {len(changed)} newly introduced crates.io package versions."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
