"""Self-contained policy tests (no scanner or external Python dependencies)."""

import argparse
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

sys.dont_write_bytecode = True

SCRIPT = Path(__file__).with_name("clone-regression-oracle.py")
SPEC = importlib.util.spec_from_file_location("clone_regression_policy", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot import the clone regression policy source")
policy = importlib.util.module_from_spec(SPEC)
loader = SPEC.loader
loader.exec_module(policy)

ROOT = SCRIPT.parents[2]
PARSER = argparse.ArgumentParser(add_help=False)
PARSER.add_argument("--wasm", type=Path)
ARGS, UNITTEST_ARGS = PARSER.parse_known_args()
WASM = ARGS.wasm.resolve() if ARGS.wasm is not None else None


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
        self.root = Path(self.temp.name).resolve()
        (self.root / "src").mkdir()

    def report(self, *groups: dict[str, Any]) -> dict[str, Any]:
        return {
            "new": list(groups),
            "smaller": [],
            "resolved": [],
            "summary": {"files": 1, "groups": len(groups)},
        }

    def run_wasm(
        self,
        raw: dict[str, Any],
        production: int,
        testing: int,
        scan_root: Path | None = None,
    ) -> subprocess.CompletedProcess[str]:
        assert WASM is not None
        return subprocess.run(
            [
                "node",
                str(ROOT / "policy-wasm/run.mjs"),
                str(WASM),
                "clones",
                str(self.root),
                str(scan_root or self.root),
                str(production),
                str(testing),
            ],
            input=json.dumps(raw),
            encoding="utf-8",
            capture_output=True,
            check=False,
        )

    def classify(
        self,
        raw: dict[str, Any],
        production: int = 100,
        testing: int = 140,
        scan_root: Path | None = None,
    ) -> dict[str, Any]:
        expected = policy.apply(raw, self.root, production, testing, scan_root)
        if WASM is not None:
            result = self.run_wasm(raw, production, testing, scan_root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), expected)
        return expected

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
        self.classify(
            self.report(
                *(
                    group(110, f"{i:012x}", ("src/mixed.rs", line, line))
                    for i, line in enumerate(
                        (test_line, fixture_line, after_line, false_marker)
                    )
                )
            )
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
        (self.root / "src" / "simple.rs").write_text(source, encoding="utf-8")
        self.classify(
            self.report(
                group(110, "123456abcdef", ("src/simple.rs", 2, 2)),
                group(110, "123456abcdea", ("src/simple.rs", 3, 3)),
            )
        )
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
        classified = self.classify(raw)
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
        result = self.classify(raw)
        self.assertEqual(result["new"], [])
        self.assertEqual(len(result["accepted"]), 1)
        self.assertEqual(result["accepted"][0]["policy_tier"], "production")
        config.write_text('min-tokens = 99999\nexclude = ["src/**"]\n')
        self.assertEqual(len(self.classify(raw)["new"]), 1)

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
            if WASM is not None:
                self.assertNotEqual(
                    self.run_wasm(self.report(), 100, 140).returncode, 0
                )
        config.unlink()
        with self.assertRaises(ValueError):
            policy.apply(self.report(), self.root, 120, 100)
        if WASM is not None:
            self.assertNotEqual(self.run_wasm(self.report(), 120, 100).returncode, 0)

    def test_scan_scope_and_arbitrary_scanner_fields(self) -> None:
        scan = self.root / "nested"
        (scan / "tests").mkdir(parents=True)
        (scan / "tests" / "a.rs").write_text("fn fixture() {}", encoding="utf-8")
        (self.root / "tests").mkdir()
        (self.root / "tests" / "outside.rs").write_text(
            "fn outside() {}", encoding="utf-8"
        )
        inner = group(120, "abcdef123456", ("tests/a.rs", 1, 1))
        inner["scanner_detail"] = {"nested": [True, 42, None]}
        inner["occurrences"][0]["snippet"] = "fn fixture() {}"
        outer = group(120, "abcdef123457", ("../tests/outside.rs", 1, 1))
        missing = group(120, "abcdef123458", ("tests/missing.rs", 1, 1))
        raw = self.report(inner, outer)
        raw["smaller"] = [missing]
        raw["unrecognized_report_field"] = {"preserve": [1, "string"]}
        result = self.classify(raw, scan_root=scan)
        self.assertEqual(
            [g["fingerprint"] for g in result["new"]], ["abcdef123457", "abcdef123458"]
        )
        self.assertEqual(result["smaller"][0]["policy_tier"], "test")
        self.assertEqual(
            result["smaller"][0]["scanner_detail"], inner["scanner_detail"]
        )
        self.assertEqual(result["smaller"][0]["occurrences"], inner["occurrences"])
        self.assertEqual(
            result["unrecognized_report_field"], raw["unrecognized_report_field"]
        )

    def test_mandatory_gate_does_not_expose_weakening_inputs(self) -> None:
        workflow = (
            Path(__file__).resolve().parents[1] / "workflows" / "clone-regression.yml"
        ).read_text()
        mandatory = workflow.split("\npermissions:", 1)[0]
        self.assertIn("workflow_call:", mandatory)
        self.assertNotIn("inputs:", mandatory)
        self.assertNotIn("inputs.", workflow)
        self.assertNotIn("CLONE_GUARD_", workflow)
        script = (
            Path(__file__).resolve().parent / "run-clone-regression.sh"
        ).read_text()
        self.assertIn("readonly discovery=50 blocking=100 test_blocking=140", script)
        self.assertIn("'tests/**' '**/tests/**'", script)
        self.assertIn("--no-config", script)
        self.assertNotIn("CLONE_GUARD_", script)
        self.assertNotIn("DOPPELSCAN_BIN", script)

    def test_cli_writes_structured_report(self) -> None:
        raw = self.report(group(150, "abcdef123456", ("src/missing.rs", 1, 1)))
        raw_path = self.root / "raw.json"
        result_path = self.root / "result.json"
        raw_path.write_text(json.dumps(raw))
        result = subprocess.run(
            [
                sys.executable,
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
        self.assertEqual(self.classify(raw), result)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0], *UNITTEST_ARGS])
