import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const QUARANTINE_MS = 72 * 60 * 60 * 1000;
const STATE_REF = "refs/heads/automation/upstream-observations";
const SHA = /^[0-9a-f]{40}$/;

export function planObservation(previous, source, tip, now, isAncestor) {
  if (!SHA.test(tip) || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Invalid upstream tip or observation time");
  }
  const prior = previous?.source === source ? previous : null;
  if (prior?.lastAttempt > now) throw new Error("Observation clock moved backwards");
  if (prior && new Date(prior.lastAttempt).toISOString().slice(0, 10) ===
      new Date(now).toISOString().slice(0, 10)) {
    return { skipped: true };
  }
  const observations = (prior?.observations ?? []).filter(({ sha }) => isAncestor(sha, tip));
  if (!observations.some(({ sha }) => sha === tip)) observations.push({ sha: tip, firstObserved: now });
  const eligible = observations.filter(({ firstObserved }) => now - firstObserved >= QUARANTINE_MS).at(-1);
  // Earlier snapshots are superseded by the latest eligible ancestor, but
  // keep that ancestor and every more recent observation for retries.
  const retained = eligible ? observations.slice(observations.indexOf(eligible)) : observations;
  return { skipped: false, eligible: eligible?.sha ?? null, state: { source, lastAttempt: now, observations: retained } };
}

function git(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...options }).trim();
}

function ancestor(a, b) {
  try {
    git(["merge-base", "--is-ancestor", a, b]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function loadState() {
  const remote = git(["ls-remote", "--refs", "origin", STATE_REF]);
  if (!remote) return { previous: null, parent: null };
  const parent = remote.split("\t")[0];
  if (!SHA.test(parent)) throw new Error("Invalid observation state ref");
  git(["fetch", "--no-tags", "origin", STATE_REF]);
  if (git(["rev-parse", "FETCH_HEAD"]) !== parent) throw new Error("Observation state changed during fetch");
  const previous = JSON.parse(git(["show", parent + ":observations.json"]));
  if (typeof previous.source !== "string" || !Number.isSafeInteger(previous.lastAttempt) ||
      previous.lastAttempt < 0 || !Array.isArray(previous.observations) ||
      previous.observations.some(({ sha, firstObserved }) => !SHA.test(sha) ||
        !Number.isSafeInteger(firstObserved) || firstObserved < 0 || firstObserved > previous.lastAttempt)) {
    throw new Error("Invalid upstream observation state");
  }
  return { previous, parent };
}

function saveState(state, parent) {
  const blob = git(["hash-object", "-w", "--stdin"], { input: JSON.stringify(state, null, 2) + "\n" });
  const tree = git(["mktree"], { input: "100644 blob " + blob + "\tobservations.json\n" });
  const commit = git(["-c", "user.name=github-actions[bot]", "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com", "commit-tree", tree,
    ...(parent ? ["-p", parent] : []), "-m", "Record upstream observation"]);
  git(["push", "origin", commit + ":" + STATE_REF]);
  return commit;
}

function main([repository, branch, strategy]) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !branch) throw new Error("Expected upstream repository and branch");
  git(["check-ref-format", "refs/heads/" + branch]);
  const source = repository + ":" + branch;
  const { previous, parent } = loadState();
  const now = Date.now();
  const output = (key, value) => appendFileSync(process.env.GITHUB_OUTPUT, key + "=" + value + "\n");
  const base = git(["rev-parse", "HEAD"]);
  output("base", base);
  if (previous?.source === source &&
      new Date(previous.lastAttempt).toISOString().slice(0, 10) === new Date(now).toISOString().slice(0, 10)) {
    output("status", "already-run");
    console.log("Upstream already observed today (UTC).");
    return;
  }
  if (previous?.source === source && previous.lastAttempt > now) throw new Error("Observation clock moved backwards");
  // Claim the day's attempt before fetching; a failed fetch cannot turn
  // manual dispatches into an unbounded retry loop.
  const attempt = saveState({
    source, lastAttempt: now, observations: previous?.source === source ? previous.observations : [],
  }, parent);
  git(["fetch", "--no-tags", "https://github.com/" + repository + ".git", "refs/heads/" + branch]);
  const tip = git(["rev-parse", "FETCH_HEAD"]);
  output("tip", tip);
  const observedAt = Date.now();
  const reachable = (sha, head) => {
    try { git(["cat-file", "-e", sha + "^{commit}"], { stdio: "pipe" }); }
    catch { return false; } // A force-pushed snapshot may no longer be fetchable.
    return ancestor(sha, head);
  };
  const result = planObservation(previous, source, tip, observedAt, reachable);
  saveState(result.state, attempt);
  let reviewed = null;
  if (strategy === "source-merge" &&
      git(["ls-tree", "-r", "--name-only", base, ".github/upstream-reconciliation/reviewed-source-sha"])) {
    reviewed = git(["show", base + ":.github/upstream-reconciliation/reviewed-source-sha"]);
    if (!SHA.test(reviewed) || !reachable(reviewed, tip)) {
      throw new Error("Reviewed source checkpoint no longer belongs to upstream history");
    }
  }
  const accepted = sha => ancestor(sha, base) || (reviewed !== null && ancestor(sha, reviewed));
  if (accepted(tip)) {
    output("upstream", tip);
    output("status", "current");
    return;
  }
  if (!result.eligible) {
    output("status", "quarantined");
    console.log("No observed upstream snapshot has aged for 72 hours.");
    return;
  }
  output("upstream", result.eligible);
  output("status", accepted(result.eligible) ? "quarantined" : "ready");
  console.log("Upstream tip " + tip + "; eligible snapshot " + result.eligible);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
