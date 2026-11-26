import assert from "node:assert/strict";
import test from "node:test";
import { isCiPath } from "./ci-paths.mjs";

test("CI entrypoints and policy surfaces always require review", () => {
  for (const path of [
    ".github/workflows/build.yml", ".github/actions/composite/action.yml",
    ".github/scripts/validate.sh", ".github/dependabot.yml",
    ".circleci/config.yml", ".buildkite/pipeline.yaml", ".ci/lint",
    "ci/generate.py", "scripts/ci-check.sh", "scripts/ci/test.rs",
    ".gitlab-ci.yml", ".travis.yml", ".drone.yml", "Jenkinsfile",
    "azure-pipelines.yml", "bitbucket-pipelines.yml",
    "rust-toolchain.toml", ".cargo/config.toml", "clippy.toml",
    "renovate.json", ".renovaterc.json",
  ]) assert.equal(isCiPath(path), true, path);
});
test("normal source and test files can still be auto-promoted", () => {
  for (const path of [
    "src/lib.rs", "tests/ci_related.rs", "Cargo.lock", "Cargo.toml",
    "README.md", "scripts/build.sh", "src/ci.rs", "src/scripts/ci.sh",
    ".github/upstream-reconciliation/reviewed-source-sha",
  ]) assert.equal(isCiPath(path), false, path);
});
