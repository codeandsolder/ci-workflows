import { execFileSync } from "node:child_process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const [target, base, head, strategy, bundle] = process.argv.slice(2);
const sha = /^[0-9a-f]{40}$/;
if (!sha.test(base ?? "") || !sha.test(head ?? "") || !["merge", "source-merge", "rebase", "squash-rebase"].includes(strategy)) {
  throw new Error("Invalid publication input");
}
const ref = "refs/heads/" + target;
git("check-ref-format", ref);
if (git("rev-parse", "HEAD") !== base) throw new Error("Fork base changed");
git("fetch", "--no-tags", bundle, "HEAD");
if (git("rev-parse", "FETCH_HEAD") !== head) throw new Error("Candidate differs from validated revision");
if (strategy === "merge" || strategy === "source-merge") git("merge-base", "--is-ancestor", base, head);
// Compare-and-swap even for fast-forward updates. Never replace an unrelated
// concurrent update, including a rollback to an ancestor of the candidate.
git("push", "--force-with-lease=" + ref + ":" + base, "origin", head + ":" + ref);
