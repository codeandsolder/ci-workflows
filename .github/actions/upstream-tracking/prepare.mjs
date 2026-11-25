import { execFileSync } from "node:child_process";
import { generatedPaths } from "./generated.mjs";
import { appendFileSync } from "node:fs";

const SHA = /^[0-9a-f]{40}$/;
const WORKFLOWS = ".github/workflows";
const CHECKPOINT = ".github/upstream-reconciliation/reviewed-source-sha";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const names = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
const workflowPath = path => path === WORKFLOWS || path.startsWith(WORKFLOWS + "/");
const tree = ref => git("rev-parse", ref + "^{tree}");
const commitList = (base, head) => git("rev-list", "--reverse", "--topo-order", "--no-merges", head, "^" + base).split("\n").filter(Boolean);

function unchanged(...args) {
  try {
    git("diff", "--quiet", ...args);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function restore(ref, paths) {
  if (paths.length) git("--literal-pathspecs", "restore", "--source=" + ref, "--staged", "--worktree", "--", ...paths);
}

function commitIfChanged(...args) {
  if (git("write-tree") !== tree("HEAD")) git("commit", ...args);
}

const [repository, branch, upstream, base, workflowPolicy, bundle, generatedInput = ""] = process.argv.slice(2);
const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !SHA.test(upstream ?? "") || !SHA.test(base ?? "")) {
  throw new Error("Invalid candidate input");
}
if (!["reject", "preserve"].includes(workflowPolicy)) throw new Error("Unknown workflow policy");
git("check-ref-format", "refs/heads/" + branch);
if (git("rev-parse", "HEAD") !== base) throw new Error("Fork base changed");
git("fetch", "--no-tags", "https://github.com/" + repository + ".git", "refs/heads/" + branch);
git("merge-base", "--is-ancestor", upstream, "FETCH_HEAD");
git("config", "user.name", "github-actions[bot]");
git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");

const generated = new Set(generatedPaths(generatedInput, base));
const common = git("merge-base", "--all", base, upstream).split("\n");
if (common.length !== 1 || !SHA.test(common[0])) throw new Error("Ambiguous fork divergence");
const divergence = common[0];
const checkpoint = git("ls-tree", base, "--", CHECKPOINT) ? git("show", base + ":" + CHECKPOINT) : null;
if (checkpoint !== null) {
  if (!SHA.test(checkpoint)) throw new Error("Invalid reviewed-source checkpoint");
  git("merge-base", "--is-ancestor", divergence, checkpoint);
  git("merge-base", "--is-ancestor", checkpoint, upstream);
}
const anchor = checkpoint ?? divergence;
const drift = !unchanged(anchor, upstream, "--", WORKFLOWS);
output("workflow_drift", drift);
if (workflowPolicy === "reject" && drift) {
  console.error(git("diff", "--name-status", anchor, upstream, "--", WORKFLOWS));
  throw new Error("Upstream workflow changes require manual reconciliation");
}

// A cherry-pick is a three-way rebase of one patch. Keep each original
// author/message; drop both already-absorbed and originally empty patches.
// Generated artifacts are rebuilt from the new source, not replayed from
// historic commits. Workflow-only conflicts may be discarded under preserve;
// the exact reviewed workflow tree is restored at the end, never imported.
function replay(commits, destination, { historical = false } = {}) {
  git("checkout", "--detach", destination);
  for (const commit of commits) {
    let failure = null;
    try {
      git("cherry-pick", "--no-commit", commit);
    } catch (error) {
      failure = error;
    }
    const conflicts = names("diff", "--no-renames", "--name-only", "--diff-filter=U", "-z");
    const permitted = path => historical || generated.has(path) ||
      (workflowPolicy === "preserve" && workflowPath(path)) ||
      (checkpoint !== null && path === CHECKPOINT);
    if (failure && (!conflicts.length || conflicts.some(path => !permitted(path)))) {
      console.error("Cannot replay fork commit " + commit + ": " + conflicts.join(", "));
      if (failure.stdout) console.error(failure.stdout);
      throw failure;
    }
    const changed = names("diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD");
    const discarded = new Set([...conflicts, ...changed.filter(path =>
      generated.has(path) || (checkpoint !== null && path === CHECKPOINT))]);
    restore("HEAD", [...discarded]);
    if (git("ls-files", "--unmerged")) throw new Error("Unresolved fork patch conflict");
    git("diff", "--exit-code");
    commitIfChanged("-C", commit);
    // A no-commit cherry-pick can leave a conflict-resolution marker.
    if (failure) git("cherry-pick", "--quit");
  }
}

// Normalize old merge-based histories on their existing upstream anchor
// before advancing it. Preserve any net merge-resolution edits as one
// explicitly named patch. Historical conflicts can be projected onto the
// already-reviewed final tree here, never during a new upstream rebase.
let patchHead = base;
let patches = commitList(divergence, base);
if (checkpoint !== null || git("rev-list", "--merges", base, "^" + divergence)) {
  replay(patches, anchor, { historical: true });
  git("read-tree", "--reset", "-u", base);
  if (checkpoint !== null) git("rm", "-f", "--", CHECKPOINT);
  commitIfChanged("-m", "Preserve reviewed historical integration resolutions");
  if (!unchanged(base, "HEAD", "--", ".", ":(exclude)" + CHECKPOINT)) {
    throw new Error("Historical normalization changed the reviewed fork tree");
  }
  patchHead = git("rev-parse", "HEAD");
  patches = commitList(anchor, patchHead);
}

// As with Git rebase, skip equivalent patches already in upstream history,
// even if the upstream subsequently edited their context.
const absorbed = new Set(git("cherry", upstream, patchHead, anchor).split("\n")
  .filter(line => line.startsWith("- ")).map(line => line.slice(2)));
replay(patches.filter(commit => !absorbed.has(commit)), upstream);
if (!unchanged(base, "HEAD", "--", WORKFLOWS)) {
  if (workflowPolicy !== "preserve") throw new Error("Candidate changes reviewed workflow files");
  // Restore only paths that actually differ, including upstream additions.
  restore(base, names("diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--", WORKFLOWS));
  commitIfChanged("-m", "Retain reviewed downstream workflows");
}
// A declared fork-only artifact may not exist upstream. Seed it from the
// reviewed base when absent, then the separate generation job replaces it.
const missing = [...generated].filter(path => !git("--literal-pathspecs", "ls-tree", "HEAD", "--", path));
restore(base, missing);
commitIfChanged("-m", "Seed fork-specific generated artifacts");
generatedPaths(generatedInput, "HEAD");
if (!unchanged(base, "HEAD", "--", WORKFLOWS)) throw new Error("Candidate changes reviewed workflow files");
git("merge-base", "--is-ancestor", upstream, "HEAD");
git("diff", "--check", upstream, "HEAD");
const head = git("rev-parse", "HEAD");
output("head", head);
output("changed", head !== base);
if (head !== base) git("bundle", "create", bundle, "HEAD", "^" + base);
