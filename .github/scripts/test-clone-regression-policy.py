"""Self-contained policy tests (no scanner or external Python dependencies)."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name("clone-regression-policy.py")
SPEC = importlib.util.spec_from_file_location("clone_regression_policy", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot import the clone regression policy source")
policy = importlib.util.module_from_spec(SPEC)
loader = SPEC.loader
loader.exec_module(policy)


def group(
    tokens: int, fingerprint: str, *locations: tuple[str, int, int]
) -> dict[str, Any]:
    return {
        "tokens": tokens,
        "fingerprint": fingerprint,
        "occurrences": [
            {"file": path, "start_line": start, "end_line": end}
            for path, start, end in locations
        ],
    }


class ClonePolicyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "src").mkdir()

    def report(self, *groups: dict[str, Any]) -> dict[str, Any]:
        return {
            "new": list(groups),
            "smaller": [],
            "resolved": [],
            "summary": {"files": 1, "groups": len(groups)},
        }

    def test_test_module_is_a_precise_scope_even_with_literals_and_comments(
        self,
    ) -> None:
        source = r"""fn prod_before() { let x = "not a test"; }
const DECOY: &str = r###"#[cfg(test)] mod decoy { fn fake() {} }"###;
/* comment with { } /* a nested { comment } */ } */
#[cfg(test)]
mod tests {
    fn shared_fixture() {
        let raw = r##"{ a } /* } */"##;
        let normal = "{ }"; let character = '{';
        let line = "// {";
        assert!(raw.len() + normal.len() + line.len() > 1);
    }
    #[test]
    fn actual_case() { assert_eq!(2 + 2, 4); }
}
fn prod_after() { let x = "}"; }
"""
        file = self.root / "src" / "mixed.rs"
        file.write_text(source)
        lines = source.splitlines()
        test_line = next(
            i for i, line in enumerate(lines, 1) if "fn actual_case" in line
        )
        fixture_line = next(
            i for i, line in enumerate(lines, 1) if "fn shared_fixture" in line
        )
        after_line = next(
            i for i, line in enumerate(lines, 1) if "fn prod_after" in line
        )
        false_marker = next(
            i for i, line in enumerate(lines, 1) if "const DECOY" in line
        )
        cache = {}
        for line in (test_line, fixture_line):
            self.assertTrue(
                policy.test_occurrence(
                    self.root,
                    {"file": "src/mixed.rs", "start_line": line, "end_line": line},
                    cache,
                ),
            )
        for line in (after_line, false_marker):
            self.assertFalse(
                policy.test_occurrence(
                    self.root,
                    {"file": "src/mixed.rs", "start_line": line, "end_line": line},
                    cache,
                ),
            )

    def test_annotation_function_without_module(self) -> None:
        source = (
            "#[test]\nfn only_test() { assert!(true); }\nfn prod() { assert!(true); }\n"
        )
        (self.root / "src" / "simple.rs").write_text(source)
        self.assertTrue(
            policy.test_occurrence(
                self.root, {"file": "src/simple.rs", "start_line": 2, "end_line": 2}, {}
            )
        )
        self.assertFalse(
            policy.test_occurrence(
                self.root, {"file": "src/simple.rs", "start_line": 3, "end_line": 3}, {}
            )
        )

    def test_strict_production_when_clone_is_mixed(self) -> None:
        (self.root / "src" / "a.rs").write_text("fn logic() {}")
        (self.root / "src" / "b.rs").write_text(
            "#[cfg(test)]\nmod tests { fn test_case() {} }\n"
        )
        prod = ("src/a.rs", 1, 1)
        test = ("src/b.rs", 2, 2)
        raw = self.report(
            group(115, "123456abcdef", test, test),
            group(115, "123456abcdea", prod, test),
            group(105, "123456abcdeb", prod, prod),
            group(95, "123456abcdec", test, test),
        )
        classified = policy.apply(raw, self.root, 100, 140)
        self.assertEqual(
            [(g["tokens"], g["policy_tier"]) for g in classified["new"]],
            [(115, "production"), (105, "production")],
        )
        self.assertEqual(
            [(g["tokens"], g["policy_tier"]) for g in classified["smaller"]],
            [(115, "test"), (95, "test")],
        )

    def test_test_filenames_and_unknown_source_are_conservative(self) -> None:
        (self.root / "src" / "smoke-real.sh").write_text("#!/bin/sh\necho test\n")
        self.assertTrue(
            policy.test_occurrence(
                self.root,
                {"file": "src/smoke-real.sh", "start_line": 2, "end_line": 2},
                {},
            )
        )
        self.assertTrue(policy.test_file("runtime/xspice/smoke-real.sh"))
        self.assertTrue(policy.test_file("src/math.spec.ts"))
        self.assertTrue(policy.test_file("tests/unusual-code.rs"))
        self.assertTrue(policy.test_file("src/subdir/test_oracle.py"))
        self.assertFalse(policy.test_file("src/math.rs"))
        self.assertFalse(
            policy.test_occurrence(
                self.root,
                {"file": "src/nonexistent.rs", "start_line": 1, "end_line": 4},
                {},
            )
        )
        self.assertFalse(
            policy.test_occurrence(
                self.root, {"file": "../outside.rs", "start_line": 1, "end_line": 4}, {}
            )
        )

    def test_documented_accepts_only_no_threshold_override(self) -> None:
        (self.root / "src" / "engine.rs").write_text("fn production() {}")
        raw = self.report(group(210, "abcdef123456", ("src/engine.rs", 1, 1)))
        config = self.root / ".doppelscan.toml"
        config.write_text(
            'min-tokens = 99999\nexclude = ["src/**"]\n'
            '[[accept]]\nfingerprint = "abcdef123456"\n'
            'reason = "Test fixture is intentionally duplicated across interfaces."\n',
        )
        result = policy.apply(raw, self.root, 100, 140)
        self.assertEqual(result["new"], [])
        self.assertEqual(len(result["accepted"]), 1)
        self.assertEqual(result["accepted"][0]["policy_tier"], "production")
        config.write_text('min-tokens = 99999\nexclude = ["src/**"]\n')
        self.assertEqual(len(policy.apply(raw, self.root, 100, 140)["new"]), 1)

    def test_invalid_accept_reasons_fail_and_bad_thresholds_fail(self) -> None:
        (self.root / "src" / "engine.rs").write_text("fn production() {}")
        config = self.root / ".doppelscan.toml"
        for fingerprint, reason in [
            ("123abc", "A detailed enough explanation"),
            ("abcdef123456", "bad"),
            ("nothex123456", "A detailed enough explanation"),
        ]:
            config.write_text(
                f'[[accept]]\nfingerprint = "{fingerprint}"\nreason = "{reason}"\n',
            )
            with self.assertRaises(ValueError):
                policy.accepted_fingerprints(self.root)
        config.unlink()
        with self.assertRaises(ValueError):
            policy.apply(self.report(), self.root, 120, 100)

    def test_cli_writes_structured_report(self) -> None:
        raw = self.report(group(150, "abcdef123456", ("src/missing.rs", 1, 1)))
        raw_path = self.root / "raw.json"
        result_path = self.root / "result.json"
        raw_path.write_text(json.dumps(raw))
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                str(raw_path),
                str(result_path),
                str(self.root),
                str(self.root),
                "100",
                "140",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        result = json.loads(result_path.read_text())
        self.assertEqual(result["policy"]["blocking"], 1)


if __name__ == "__main__":
    unittest.main()
