import { execFileSync } from "node:child_process";
import { verifyGenerated } from "./generated.mjs";
import { archiveRef } from "./history.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const [target, base, head, upstream, bundle, source, generated] = process.argv.slice(2);
const sha = /^[0-9a-f]{40}$/;
if (![base, head, upstream].every(value => sha.test(value ?? ""))) throw new Error("Invalid publication input");
const ref = "refs/heads/" + target;
git("check-ref-format", ref);
if (git("rev-parse", "HEAD") !== base) throw new Error("Fork base changed");
git("fetch", "--no-tags", bundle, "HEAD");
if (git("rev-parse", "FETCH_HEAD") !== head) throw new Error("Candidate differs from validated revision");
git("merge-base", "--is-ancestor", upstream, head);
git("diff", "--exit-code", base, head, "--", ".github/workflows");
if (source) verifyGenerated(source, head, generated);

// Keep immutable reachability for downstream Cargo Git pins and old reviewed
// commits. Publish the archive and new branch in the same atomic transaction;
// an unexpected concurrent base (even a rollback) cannot be overwritten.
const archive = archiveRef(base, upstream);
const remote = git("ls-remote", "--refs", "origin", archive);
if (remote && remote !== base + "\t" + archive) throw new Error("Fork history archive points elsewhere");
git("push", "--atomic", "--force-with-lease=" + ref + ":" + base,
  "--force-with-lease=" + archive + ":" + (remote ? base : ""),
  "origin", base + ":" + archive, head + ":" + ref);
