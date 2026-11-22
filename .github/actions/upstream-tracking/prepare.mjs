import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const WORKFLOWS = ".github/workflows";
const CHECKPOINT = ".github/upstream-reconciliation/reviewed-source-sha";

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch (error) {
    if (error.stdout) console.error(error.stdout);
    throw error;
  }
}

function unchanged(...args) {
  try {
    git("diff", "--quiet", ...args);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

const [repository, branch, upstream, base, strategy, workflowPolicy, bundle] = process.argv.slice(2);
const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !SHA.test(upstream ?? "") || !SHA.test(base ?? "")) {
  throw new Error("Invalid candidate input");
}
git("check-ref-format", "refs/heads/" + branch);
if (git("rev-parse", "HEAD") !== base) throw new Error("Fork base changed");
git("fetch", "--no-tags", "https://github.com/" + repository + ".git", "refs/heads/" + branch);
git("merge-base", "--is-ancestor", upstream, "FETCH_HEAD");
git("config", "user.name", "github-actions[bot]");
git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");

let forkBase = git("merge-base", base, upstream);
let reviewed = null;
if (strategy === "source-merge" && existsSync(CHECKPOINT)) {
  reviewed = readFileSync(CHECKPOINT, "utf8").trim();
  if (!SHA.test(reviewed)) throw new Error("Invalid reviewed-source checkpoint");
  git("merge-base", "--is-ancestor", reviewed, upstream);
  forkBase = reviewed;
}
const drift = !unchanged(forkBase, upstream, "--", WORKFLOWS);
output("workflow_drift", drift);
if (workflowPolicy === "reject" && drift) {
  console.error(git("diff", "--name-status", forkBase, upstream, "--", WORKFLOWS));
  throw new Error("Upstream workflow changes require manual reconciliation");
}
if (!["reject", "preserve"].includes(workflowPolicy)) throw new Error("Unknown workflow policy");

function restoreWorkflows(source) {
  git("restore", "--source=" + source, "--staged", "--worktree", WORKFLOWS);
}
switch (strategy) {
  case "merge":
    git("merge", "--no-ff", "--no-edit", upstream);
    break;
  case "source-merge":
    if (!reviewed) {
      git("merge", "--no-ff", "--no-edit", upstream);
    } else if (reviewed !== upstream) {
      const tree = git("merge-tree", "--write-tree", "--merge-base=" + reviewed, base, upstream);
      git("read-tree", "-u", "--reset", tree);
      restoreWorkflows(base);
      writeFileSync(CHECKPOINT, upstream + "\n");
      git("add", CHECKPOINT);
      git("commit", "-m", "Integrate reviewed-source upstream snapshot " + upstream);
    }
    break;
  case "rebase":
    git("rebase", upstream);
    break;
  case "squash-rebase":
    // Preserve only the downstream source patch against the common
    // ancestor, then restore the reviewed workflow subtree.
    git("reset", "--soft", forkBase);
    restoreWorkflows(forkBase);
    if (!unchanged("--cached")) git("commit", "-m", "Carry downstream patch");
    git("rebase", upstream);
    restoreWorkflows(base);
    if (!unchanged("--cached")) git("commit", "-m", "Retain reviewed downstream workflows");
    break;
  default:
    throw new Error("Unknown integration strategy: " + strategy);
}

if (!unchanged(base, "HEAD", "--", WORKFLOWS)) {
  console.error(git("diff", "--name-status", base, "HEAD", "--", WORKFLOWS));
  throw new Error("Candidate changes reviewed workflow files");
}
git("diff", "--check", upstream, "HEAD");
const head = git("rev-parse", "HEAD");
output("head", head);
output("changed", head !== base);
if (head !== base) git("bundle", "create", bundle, "HEAD", "^" + base);
