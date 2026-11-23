import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const NIGHTLY = /^nightly-\d{4}-\d{2}-\d{2}$/;
const PACKAGE = /^[a-zA-Z0-9][a-zA-Z0-9+_.:=-]*$/;
const TARGET = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

function run(program, args, extra = {}) {
  execFileSync(program, args, { stdio: "inherit", ...extra });
}

function requireSafeRelative(value, label) {
  if (typeof value !== "string" || value === "" || value.startsWith("/")
      || value.split("/").some((part) => part === ".." || part === "")
      || value.includes("\\") || value.includes("\0")) {
    throw new Error("invalid reviewed " + label + ": " + value);
  }
  return value;
}

function assertReviewedRustDirectory(root, job) {
  // Even a reviewed relative path can point outside the candidate if the
  // upstream update replaces one of its path components with a symlink.
  const canonicalRoot = realpathSync(root);
  const requested = path.join(canonicalRoot, job.workingDirectory);
  const actual = realpathSync(requested);
  if (actual !== canonicalRoot && !actual.startsWith(canonicalRoot + path.sep)) {
    throw new Error("strict reviewed working-directory resolves outside the candidate: " + job.workingDirectory);
  }
  const manifest = path.join(actual, "Cargo.toml");
  if (!existsSync(manifest)) {
    throw new Error("reviewed strict job " + job.workflow + ":" + job.job
      + " has no Cargo.toml at " + job.workingDirectory
      + "; nested-only Rust sources need a reviewed strict working-directory");
  }
  const manifestReal = realpathSync(manifest);
  if (manifestReal !== canonicalRoot && !manifestReal.startsWith(canonicalRoot + path.sep)) {
    throw new Error("strict Cargo.toml resolves outside the candidate: " + job.workingDirectory);
  }
}

function uniqueWords(plans, key, split) {
  return [...new Set(plans.flatMap((job) =>
    job[key] ? job[key].split(split).filter(Boolean) : []))];
}

export function validatePlan(plan, selectedCompiler) {
  if (!plan || typeof plan !== "object" || !SHA.test(plan.refSha)
      || !Array.isArray(plan.jobs) || plan.jobs.length === 0) {
    throw new Error("missing reviewed strict Rust jobs or invalid pinned gate");
  }
  for (const job of plan.jobs) {
    if (!NIGHTLY.test(job.rustToolchain || selectedCompiler)) {
      throw new Error("strict Rust requires a reviewed dated nightly: " + (job.rustToolchain || selectedCompiler));
    }
    requireSafeRelative(job.workingDirectory, "working-directory");
    if (!["true", "false"].includes(job.banPythonOutsideCi)
        || !["true", "false"].includes(job.allowTestPanics)
        || !["false", "true", "recursive"].includes(job.checkoutSubmodules)
        || !job.cargoArgs || typeof job.cargoArgs !== "string") {
      throw new Error("invalid reviewed strict options: " + job.workflow + ":" + job.job);
    }
  }
  for (const pkg of uniqueWords(plan.jobs, "aptPackages", /\s+/)) {
    if (!PACKAGE.test(pkg)) throw new Error("invalid reviewed apt package: " + pkg);
  }
  for (const target of uniqueWords(plan.jobs, "rustTargets", /[\s,]+/)) {
    if (!TARGET.test(target)) throw new Error("invalid reviewed Rust target: " + target);
  }
  return plan;
}

export function executePlan(plan, selectedCompiler, root, gateDir) {
  validatePlan(plan, selectedCompiler);
  if (execFileSync("git", ["-C", gateDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== plan.refSha) {
    throw new Error("checked-out strict Rust trust root does not match reviewed target-branch policy");
  }
  const pythonScript = path.join(gateDir, "scripts/strict_python.sh");
  const rustScript = path.join(gateDir, "scripts/strict_clippy.sh");
  if (!existsSync(pythonScript) || !existsSync(rustScript)) throw new Error("reviewed gate implementation incomplete");
  // A reviewed strict working-directory may point into a pinned submodule.
  // Populate the committed gitlinks before resolving and containing paths.
  if (plan.jobs.some((job) => job.checkoutSubmodules !== "false")) {
    const recursive = plan.jobs.some((job) => job.checkoutSubmodules === "recursive");
    run("git", ["-C", root, "submodule", "update", "--init", ...(recursive ? ["--recursive"] : [])]);
  }
  for (const job of plan.jobs) assertReviewedRustDirectory(root, job);
  const packages = uniqueWords(plan.jobs, "aptPackages", /\s+/);
  if (packages.length) {
    run("sudo", ["apt-get", "update"]);
    run("sudo", ["apt-get", "install", "-y", "--", ...packages]);
  }
  // The reviewed strict workflow may select a different dated nightly from
  // the upstream validator. Preserve its actual compiler contract instead of
  // assuming that the already installed default happens to cover it.
  const compilers = new Set(plan.jobs.map((job) => job.rustToolchain || selectedCompiler));
  for (const compiler of compilers) {
    if (compiler !== selectedCompiler) {
      run("rustup", ["toolchain", "install", compiler, "--profile", "minimal", "--component", "clippy,rustfmt"]);
    }
  }
  const targetGroups = new Map();
  for (const job of plan.jobs) {
    const compiler = job.rustToolchain || selectedCompiler;
    for (const target of job.rustTargets.split(/[\s,]+/).filter(Boolean)) {
      if (!targetGroups.has(compiler)) targetGroups.set(compiler, new Set());
      targetGroups.get(compiler).add(target);
    }
  }
  for (const [compiler, targets] of targetGroups) {
    run("rustup", ["target", "add", "--toolchain", compiler, ...targets]);
  }
  // Apply the actual reviewed gate scripts, including each distinct Python
  // configuration. No source policy is copied from the upstream candidate.
  const completedPython = new Set();
  for (const job of plan.jobs) {
    const config = JSON.stringify([job.banPythonOutsideCi, job.pythonCiPaths]);
    if (completedPython.has(config)) continue;
    completedPython.add(config);
    run("bash", [pythonScript], {
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root,
        RUST_SKILLS2_REPOSITORY_ROOT: root,
        RUST_SKILLS2_PYTHON_ACTION_DIR: path.join(gateDir, ".github/actions/python-strict"),
        RUST_SKILLS2_BAN_PYTHON_OUTSIDE_CI: job.banPythonOutsideCi,
        RUST_SKILLS2_PYTHON_CI_PATHS: job.pythonCiPaths,
      },
    });
  }
  for (const job of plan.jobs) {
    const compiler = job.rustToolchain || selectedCompiler;
    console.log("Reviewed strict Rust: " + job.workflow + " / " + job.job + " (" + compiler + ")");
    run("bash", [rustScript, "--toolchain", compiler], {
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root,
        RUST_SKILLS2_ACTION_DIR: path.join(gateDir, ".github/actions/rust-strict"),
        RUST_SKILLS2_WORKING_DIRECTORY: job.workingDirectory,
        RUST_SKILLS2_CARGO_ARGS: job.cargoArgs,
        RUST_SKILLS2_ALLOW_TEST_PANICS: job.allowTestPanics,
      },
    });
  }
  run("git", ["-C", root, "diff", "--exit-code", "HEAD", "--"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [planPath, compiler, root, gateDir] = process.argv.slice(2);
  if (!planPath || !compiler || !root || !gateDir) throw new Error("usage: run-strict.mjs PLAN_JSON SELECTED_COMPILER CANDIDATE_ROOT PINNED_GATE_DIR");
  executePlan(JSON.parse(readFileSync(planPath, "utf8")), compiler, realpathSync(root), realpathSync(gateDir));
}
