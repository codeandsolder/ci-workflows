import test from "node:test";
import assert from "node:assert/strict";
import {validatePlan} from "./run-strict.mjs";

const base = {
  refSha: "e007c336924c41b4d8931aabd60fa1614967657c",
  jobs: [{
    workflow: "strict-rust.yml",
    job: "rust",
    cargoArgs: "--locked --workspace --all-targets",
    workingDirectory: ".",
    rustToolchain: "",
    rustTargets: "wasm32-wasip1",
    aptPackages: "libssl-dev pkg-config",
    checkoutSubmodules: "false",
    pythonCiPaths: "",
    banPythonOutsideCi: "true",
    allowTestPanics: "false",
  }],
};

test("full reviewed config runs on pinned nightly without mutating inputs", () => {
  assert.equal(validatePlan(structuredClone(base), "nightly-2026-11-19").jobs[0].workingDirectory, ".");
});
test("rejects ambiguous toolchain, unsafe directory and apt selectors", () => {
  assert.throws(() => validatePlan(base, "stable"), /dated nightly/);
  assert.throws(() => validatePlan({...base, jobs:[{...base.jobs[0], workingDirectory:"../outside"}]}, "nightly-2026-11-19"), /working-directory/);
  assert.throws(() => validatePlan({...base, jobs:[{...base.jobs[0], aptPackages:"libssl-dev;echo"}]}, "nightly-2026-11-19"), /apt package/);
  assert.throws(() => validatePlan({...base, refSha:"main"}, "nightly-2026-11-19"), /pinned gate/);
});

import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {executePlan} from "./run-strict.mjs";

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {encoding:"utf8"}).trim();
}

function commit(root) {
  git(root, "add", ".");
  git(root, "-c", "user.name=CI integration test", "-c", "user.email=ci@example.invalid", "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD");
}

test("candidate validation calls reviewed Python and Rust in order, and failures prevent Rust", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "ci-reviewed-gate-"));
  try {
    const candidate = path.join(temp, "candidate");
    const gate = path.join(temp, "reviewed");
    for (const root of [candidate, gate]) {
      mkdirSync(root);
      git(root, "init", "-q", "-b", "main");
    }
    // The fixture's observed script-order log is deliberately not source;
    // subsequent fixture commits must not accidentally track it.
    writeFileSync(path.join(candidate, ".git", "info", "exclude"), ".events\n");
    mkdirSync(path.join(gate, "scripts"));
    const python = path.join(gate, "scripts", "strict_python.sh");
    const rust = path.join(gate, "scripts", "strict_clippy.sh");
    writeFileSync(python, [
      "#!/bin/sh",
      "set -eu",
      "printf 'python:%s:%s\\n' \"$RUST_SKILLS2_BAN_PYTHON_OUTSIDE_CI\" \"$RUST_SKILLS2_PYTHON_CI_PATHS\" >> \"$GITHUB_WORKSPACE/.events\"",
      "test ! -f \"$GITHUB_WORKSPACE/forbidden.py\"",
      ""
    ].join("\n"));
    writeFileSync(rust, [
      "#!/bin/sh",
      "set -eu",
      "printf 'rust:%s:%s:%s\\n' \"$RUST_SKILLS2_WORKING_DIRECTORY\" \"$RUST_SKILLS2_CARGO_ARGS\" \"$RUST_SKILLS2_ALLOW_TEST_PANICS\" >> \"$GITHUB_WORKSPACE/.events\"",
      ""
    ].join("\n"));
    const refSha = commit(gate);
    writeFileSync(path.join(candidate, "Cargo.toml"), "[workspace]\n");
    commit(candidate);
    const plan = structuredClone(base);
    plan.refSha = refSha;
    plan.jobs[0].aptPackages = "";
    plan.jobs[0].rustTargets = "";
    executePlan(plan, "nightly-2026-11-19", candidate, gate);
    const events = readFileSync(path.join(candidate, ".events"), "utf8");
    assert.match(events, /^python:true:\nrust:\.:--locked --workspace --all-targets:false\n$/);

    // Source-driven Rust selection also covers repositories with nested-only
    // Cargo workspaces. A default root job fails with an actionable message;
    // a reviewed explicit nested working directory continues to work.
    mkdirSync(path.join(candidate, "nested"));
    writeFileSync(path.join(candidate, "nested", "Cargo.toml"), '[package]\nname="nested"\nversion="0.1.0"\n');
    git(candidate, "rm", "-q", "Cargo.toml");
    commit(candidate);
    assert.throws(
      () => executePlan(plan, "nightly-2026-11-19", candidate, gate),
      /nested-only Rust sources need a reviewed strict working-directory/
    );
    const nestedPlan = structuredClone(plan);
    nestedPlan.jobs[0].workingDirectory = "nested";
    executePlan(nestedPlan, "nightly-2026-11-19", candidate, gate);
    assert.match(readFileSync(path.join(candidate, ".events"), "utf8"), /rust:nested:--locked --workspace --all-targets:false/);

    // A tracked symlink in the candidate must not redirect even a reviewed,
    // syntactically safe working-directory into a different filesystem tree.
    const external = path.join(temp, "external");
    mkdirSync(external);
    writeFileSync(path.join(external, "Cargo.toml"), "[workspace]\n");
    symlinkSync(external, path.join(candidate, "escaped"), "dir");
    commit(candidate);
    const escapedPlan = structuredClone(plan);
    escapedPlan.jobs[0].workingDirectory = "escaped";
    assert.throws(
      () => executePlan(escapedPlan, "nightly-2026-11-19", candidate, gate),
      /working-directory resolves outside the candidate/
    );

    // Restore the default root workspace for the existing Python rejection.
    writeFileSync(path.join(candidate, "Cargo.toml"), "[workspace]\n");
    commit(candidate);

    // The upstream candidate passes its own source tests but adds a Python
    // file forbidden by the target-base strict configuration: fail closed.
    writeFileSync(path.join(candidate, "forbidden.py"), "print('unreviewed Python')\n");
    commit(candidate);
    assert.throws(
      () => executePlan(plan, "nightly-2026-11-19", candidate, gate),
      /Command failed/
    );
    const after = readFileSync(path.join(candidate, ".events"), "utf8");
    assert.match(after, /python:true:\n$/);
    assert.equal((after.match(/rust:/g) ?? []).length, 2);

    const unreviewed = structuredClone(plan);
    unreviewed.refSha = "a".repeat(40);
    assert.throws(
      () => executePlan(unreviewed, "nightly-2026-11-19", candidate, gate),
      /reviewed target-branch policy/
    );
  } finally {
    rmSync(temp, {recursive:true, force:true});
  }
});

test("reviewed strict job initializes pinned Git submodule before Cargo workspace preflight", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "ci-reviewed-submodule-"));
  try {
    const source = path.join(temp, "module-source");
    const candidate = path.join(temp, "candidate");
    const gate = path.join(temp, "reviewed");
    for (const repo of [source, candidate, gate]) {
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
    }
    writeFileSync(path.join(source, "Cargo.toml"), "[workspace]\n");
    commit(source);

    mkdirSync(path.join(gate, "scripts"));
    writeFileSync(path.join(gate, "scripts", "strict_python.sh"), "#!/bin/sh\nset -eu\n");
    writeFileSync(path.join(gate, "scripts", "strict_clippy.sh"), "#!/bin/sh\nset -eu\n");
    const refSha = commit(gate);

    // Local-only Git protocol is explicitly enabled in this fixture. The
    // production runner never changes Git's transport/security settings.
    git(candidate, "config", "protocol.file.allow", "always");
    git(candidate, "-c", "protocol.file.allow=always",
      "submodule", "add", "-q", source, "modules/workspace");
    commit(candidate);
    git(candidate, "submodule", "deinit", "-f", "--", "modules/workspace");
    const manifest = path.join(candidate, "modules", "workspace", "Cargo.toml");
    assert.equal(existsSync(manifest), false, "initial fixture has no checked-out submodule");

    const plan = structuredClone(base);
    plan.refSha = refSha;
    plan.jobs[0].workingDirectory = "modules/workspace";
    plan.jobs[0].checkoutSubmodules = "true";
    plan.jobs[0].aptPackages = "";
    plan.jobs[0].rustTargets = "";
    executePlan(plan, "nightly-2026-11-19", candidate, gate);
    assert.equal(existsSync(manifest), true, "the reviewed job initializes its pinned submodule");
    assert.equal(git(candidate, "diff", "--name-only", "HEAD", "--"), "");

    git(candidate, "submodule", "deinit", "-f", "--", "modules/workspace");
    plan.jobs[0].checkoutSubmodules = "false";
    assert.throws(
      () => executePlan(plan, "nightly-2026-11-19", candidate, gate),
      /no Cargo.toml/
    );
  } finally {
    rmSync(temp, {recursive:true,force:true});
  }
});
