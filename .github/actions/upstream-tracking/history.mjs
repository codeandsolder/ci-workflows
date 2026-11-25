import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/;
const prefix = "refs/tags/fork-history/";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

export function archiveRef(base, upstream) {
  if (!SHA.test(base) || !SHA.test(upstream)) throw new Error("Invalid fork history revision");
  return prefix + base + "/" + upstream;
}

export function ancestor(a, b) {
  try {
    git("merge-base", "--is-ancestor", a, b);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function exists(commit) {
  try {
    git("cat-file", "-e", commit + "^{commit}");
    return true;
  } catch (error) {
    if (error.status === 128 || error.status === 1) return false;
    throw error;
  }
}

// Each atomic archive records both the replaced fork head (the tag target)
// and the upstream revision that was actually integrated (in the ref name).
// Only anchors in the current fork's ancestry count, including after a
// rollback. This prevents replaying upstream-owned commits discarded by an
// upstream history rewrite as if they were fork patches.
export function priorAnchor(base) {
  const records = git("ls-remote", "--refs", "origin", prefix + "*").split("\n").filter(Boolean);
  const candidates = new Set();
  for (const record of records) {
    const [target, ref] = record.split("\t");
    const [oldBase, upstream, extra] = ref.slice(prefix.length).split("/");
    if (extra !== undefined || archiveRef(oldBase, upstream) !== ref || target !== oldBase) {
      throw new Error("Invalid immutable fork-history ref: " + record);
    }
    if (exists(upstream) && ancestor(upstream, base)) candidates.add(upstream);
  }
  const maximal = [];
  for (const candidate of candidates) {
    if (maximal.some(other => ancestor(candidate, other))) continue;
    for (let i = maximal.length - 1; i >= 0; i--) {
      if (ancestor(maximal[i], candidate)) maximal.splice(i, 1);
    }
    maximal.push(candidate);
  }
  if (maximal.length > 1) throw new Error("Ambiguous previously integrated upstream ancestry");
  return maximal[0] ?? null;
}
