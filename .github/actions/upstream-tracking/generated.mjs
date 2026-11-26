import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isCiPath, CHECKPOINT } from "./ci-paths.mjs";

const sha = /^[0-9a-f]{40}$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const names = (...args) => execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);

export function generatedPaths(input = "", base = "HEAD") {
  const paths = input.split(/\s+/).filter(Boolean);
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate generated paths");
  for (const path of paths) {
    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) ||
        path.split("/").some(part => [".", "..", ".git"].includes(part.toLowerCase())) ||
        isCiPath(path) || path === CHECKPOINT) {
      throw new Error("Invalid generated path: " + path);
    }
    const object = git("ls-tree", base, "--", path);
    if (!/^100(?:644|755) blob [0-9a-f]{40}\t/.test(object) ||
        object.slice(object.indexOf("\t") + 1) !== path) {
      throw new Error("Generated path must be an existing regular tracked file: " + path);
    }
  }
  return paths;
}

function requireOnly(paths, changed) {
  const allowed = new Set(paths);
  const extra = changed.filter(path => !allowed.has(path));
  if (extra.length) throw new Error("Generation changed unlisted files: " + extra.join(", "));
}

export function verifyGenerated(source, head, input) {
  if (!sha.test(source) || !sha.test(head)) throw new Error("Invalid generation revision");
  const paths = generatedPaths(input, source);
  if (head !== source && git("rev-list", "--parents", "-n", "1", head) !== head + " " + source) {
    throw new Error("Generation must be exactly one child of the prepared candidate");
  }
  requireOnly(paths, names("diff", "--no-renames", "--name-only", "-z", source, head));
  generatedPaths(input, head); // reject removal, symlinks and submodules
}

function commitGenerated(source, base, input, bundle) {
  if (!sha.test(source) || !sha.test(base) || git("rev-parse", "HEAD") !== source) {
    throw new Error("Generator changed the prepared revision");
  }
  const paths = generatedPaths(input, source);
  if (!paths.length) throw new Error("No generated files configured");
  requireOnly(paths, names("diff", "--no-renames", "--name-only", "-z", "HEAD"));
  // Generation must start from and produce a clean tracked source tree.
  git("add", "--", ...paths);
  requireOnly(paths, names("diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"));
  for (const path of paths) {
    const indexed = git("ls-files", "--stage", "--", path);
    if (!/^100(?:644|755) [0-9a-f]{40} 0\t/.test(indexed) ||
        indexed.slice(indexed.indexOf("\t") + 1) !== path) {
      throw new Error("Generator removed or changed the type of artifact: " + path);
    }
  }
  git("diff", "--cached", "--check");
  if (git("write-tree") !== git("rev-parse", "HEAD^{tree}")) {
    git("-c", "user.name=github-actions[bot]", "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit", "-m", "Regenerate fork build artifacts");
  }
  const head = git("rev-parse", "HEAD");
  verifyGenerated(source, head, input);
  git("diff", "--exit-code", "HEAD", "--");
  git("bundle", "create", bundle, "HEAD", "^" + base);
  appendFileSync(process.env.GITHUB_OUTPUT, "head=" + head + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "commit") commitGenerated(...args);
  else if (mode === "verify") verifyGenerated(...args);
  else throw new Error("Unknown generation operation");
}
