#!/usr/bin/env python3
"""Post-process the pinned clone scanner's *base-relative* report.

Production clones retain the strict threshold. Independently identified test
clones use the more generous test threshold; mixed copies are production.
Only [[accept]] fingerprints/reasons are loaded from repository config:
scanner thresholds/exclusions cannot be overridden by caller settings.
"""
from __future__ import annotations

import bisect
import json
import re
import sys
import tomllib
from pathlib import Path

CFG_TEST_MODULE = re.compile(
    r"#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*"
    r"(?:pub(?:\([^)]*\))?\s+)?mod\s+[a-zA-Z_]\w*\s*\{"
)
TEST_FUNCTION = re.compile(
    r"#\s*\[\s*(?:(?:tokio|async_std)::)?test(?:\([^]]*\))?\s*\]\s*"
    r"(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+[a-zA-Z_]\w*"
    r"[^{};]*\{"
)
RAW_STRING = re.compile(r"(?:br|rb|r)(#{0,32})\"")
CHAR = re.compile(r"'(?:\\(?:u\{[a-fA-F0-9_]+\}|x[a-fA-F0-9]{2}|.)|[^\\'\n])'")
FP = re.compile(r"[a-fA-F0-9]{12}")


def rust_structure(source: str) -> str:
    """Keep Rust punctuation/newlines, blank literal/comment contents.

    Necessary so braces in test fixture strings, including raw strings and
    nested comments, cannot make a production item look like test code.
    """
    chars = list(source)
    n = len(source)
    i = 0

    def erase(start: int, end: int) -> None:
        for at in range(start, end):
            if chars[at] != "\n":
                chars[at] = " "

    while i < n:
        start = i
        if source.startswith("//", i):
            end = source.find("\n", i)
            i = n if end < 0 else end
        elif source.startswith("/*", i):
            i += 2
            depth = 1
            while i < n and depth:
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                elif source.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
        else:
            raw = RAW_STRING.match(source, i) if (
                i == 0 or not (source[i - 1].isalnum() or source[i - 1] == "_")
            ) else None
            if raw is not None:
                close = '"' + raw.group(1)
                end = source.find(close, raw.end())
                i = n if end < 0 else end + len(close)
            elif source[i] == '"' or (
                source[i] in ("b", "c") and i + 1 < n and source[i + 1] == '"'
                and (i == 0 or not (source[i - 1].isalnum() or source[i - 1] == "_"))
            ):
                i += 1 if source[i] == '"' else 2
                while i < n:
                    if source[i] == "\\":
                        i += 2
                    elif source[i] == '"':
                        i += 1
                        break
                    else:
                        i += 1
            elif source[i] == "'":
                char = CHAR.match(source, i)
                if char is None:
                    i += 1
                    continue  # Rust lifetime, not a character literal
                i = char.end()
            else:
                i += 1
                continue
        erase(start, min(i, n))
    return "".join(chars)


def rust_test_intervals(source: str) -> list[tuple[int, int]]:
    structural = rust_structure(source)
    starts = [0] + [match.end() for match in re.finditer("\n", structural)]

    def line(index: int) -> int:
        return bisect.bisect_right(starts, index)

    spans = []
    for pattern in (CFG_TEST_MODULE, TEST_FUNCTION):
        for match in pattern.finditer(structural):
            opening = match.end() - 1
            depth = 1
            cursor = opening + 1
            while cursor < len(structural) and depth:
                if structural[cursor] == "{":
                    depth += 1
                elif structural[cursor] == "}":
                    depth -= 1
                cursor += 1
            if depth == 0:
                spans.append((line(match.start()), line(cursor - 1)))
    return spans


def test_file(relative: str) -> bool:
    path = Path(relative)
    components = [part.lower() for part in path.parts]
    name = path.name.lower()
    if any(part in {"test", "tests", "__tests__", "spec", "specs"} for part in components[:-1]):
        return True
    if name in {"tests.rs", "test.rs", "conftest.py"}:
        return True
    if name.startswith(("test_", "test-", "smoke-", "spec_")):
        return True
    if name.endswith(("_test.rs", "_test.py", ".test.js", ".test.ts", ".test.jsx",
                      ".test.tsx", ".spec.js", ".spec.ts", ".spec.jsx", ".spec.tsx",
                      ".spec.py", ".spec.sh")):
        return True
    return False


def test_occurrence(root: Path, item: dict, cache: dict[str, list[tuple[int, int]]]) -> bool:
    relative = item["file"]
    file = (root / relative).resolve()
    try:
        file.relative_to(root)
        if not file.is_file():
            return False
    except ValueError:
        return False  # outside scan scope is always conservatively production
    if test_file(relative):
        return True
    if not relative.endswith(".rs"):
        return False
    if relative not in cache:
        try:
            cache[relative] = rust_test_intervals(file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError):
            cache[relative] = []  # unclassifiable code stays production
    first = item["start_line"]
    last = item["end_line"]
    return any(first >= start and last <= end for start, end in cache[relative])


def accepted_fingerprints(root: Path) -> dict[str, str]:
    config = root / ".doppelscan.toml"
    if not config.is_file():
        return {}
    obj = tomllib.loads(config.read_text(encoding="utf-8"))
    result: dict[str, str] = {}
    for entry in obj.get("accept", []):
        if not isinstance(entry, dict):
            raise ValueError("each [[accept]] must be a table")
        fp = entry.get("fingerprint")
        reason = entry.get("reason")
        if not isinstance(fp, str) or FP.fullmatch(fp) is None:
            raise ValueError("accepted fingerprint must be the 12-digit scanner hex ID")
        if not isinstance(reason, str) or len(reason.strip()) < 12:
            raise ValueError(f"accepted clone {fp} requires a meaningful reason")
        if fp.lower() in result:
            raise ValueError(f"duplicate accepted fingerprint {fp}")
        result[fp.lower()] = reason.strip()
    return result


def apply(
    raw: dict, root: Path, production: int, testing: int, scan_root: Path | None = None
) -> dict:
    if production < 1 or testing < production:
        raise ValueError("test blocking threshold must be >= production threshold > 0")
    accepts = accepted_fingerprints(root)
    scan_root = scan_root or root
    cache: dict[str, list[tuple[int, int]]] = {}
    result = {**raw, "new": [], "smaller": [], "accepted": []}
    for group in raw["new"] + raw["smaller"]:
        members = group["occurrences"]
        tier = "test" if members and all(test_occurrence(scan_root, m, cache) for m in members) else "production"
        threshold = testing if tier == "test" else production
        classified = {**group, "policy_tier": tier, "policy_blocking_tokens": threshold}
        reason = accepts.get(group["fingerprint"].lower())
        if reason is not None:
            result["accepted"].append({**classified, "accept_reason": reason})
        elif group["tokens"] >= threshold:
            result["new"].append(classified)
        else:
            result["smaller"].append(classified)
    result["policy"] = {
        "production_blocking_tokens": production,
        "test_blocking_tokens": testing,
        "blocking": len(result["new"]),
        "advisory": len(result["smaller"]),
        "accepted": len(result["accepted"]),
    }
    result["note"] = (
        f"{len(result['smaller'])} new clone groups remain advisory under their "
        f"{production}-token production / {testing}-token test thresholds; "
        f"{len(result['accepted'])} explicitly accepted by documented fingerprint."
    )
    return result


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit(
            "usage: clone-regression-policy.py RAW_REPORT OUTPUT_REPORT ROOT SCAN_ROOT PROD_TOKENS TEST_TOKENS"
        )
    raw_file, output_file, workspace, scan_path, prod, test = sys.argv[1:]
    root = Path(workspace).resolve()
    scan_root = Path(scan_path).resolve()
    scan_root.relative_to(root)  # fail closed if caller selected an escaping scan path
    report = apply(
        json.loads(Path(raw_file).read_text()), root, int(prod), int(test), scan_root
    )
    Path(output_file).write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
