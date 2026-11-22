import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const sha = /^[0-9a-f]{40}$/;
const prefixPattern = /^[a-zA-Z0-9._-]+$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

export function versionFromTag(tag, prefix) {
  if (!prefixPattern.test(prefix) || !tag.startsWith(prefix)) return null;
  const version = tag.slice(prefix.length);
  return versionPattern.test(version) ? version : null;
}

export function stableReleases(releases, prefix, now) {
  if (!prefixPattern.test(prefix)) throw new Error("Invalid upstream release prefix");
  return releases.filter(release =>
    !release.draft && !release.prerelease &&
    Number.isFinite(Date.parse(release.published_at)) && Date.parse(release.published_at) <= now &&
    versionFromTag(release.tag_name, prefix) !== null
  ).sort((a, b) => {
    const left = versionFromTag(a.tag_name, prefix).split(".").map(BigInt);
    const right = versionFromTag(b.tag_name, prefix).split(".").map(BigInt);
    for (let i = 0; i < 3; i++) {
      if (left[i] !== right[i]) return left[i] > right[i] ? -1 : 1;
    }
    return 0;
  });
}

export function listReleases(repository, prefix, now) {
  return stableReleases(JSON.parse(gh("api", "--paginate", "--slurp",
    "repos/" + repository + "/releases?per_page=100")).flat(), prefix, now);
}

export function remoteTagCommits(remote, tags) {
  const refs = tags.flatMap(tag => ["refs/tags/" + tag, "refs/tags/" + tag + "^{}"]);
  if (!refs.length) return new Map();
  const raw = git("ls-remote", "--tags", remote, ...refs);
  const values = new Map(raw.split("\n").filter(Boolean).map(line => {
    const [commit, ref] = line.split("\t");
    if (!sha.test(commit)) throw new Error("Invalid remote tag object");
    return [ref, commit];
  }));
  return new Map(tags.flatMap(tag => {
    const ref = "refs/tags/" + tag;
    const commit = values.get(ref + "^{}") ?? values.get(ref);
    return commit ? [[tag, commit]] : [];
  }));
}

// The exact commit of the published tag is passed through observation,
// preparation and validation. Never release an arbitrary later branch tip.
function publishRelease(repository, upstreamRepository, prefix, upstreamTag, upstream, head, target) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !/^[\w.-]+\/[\w.-]+$/.test(upstreamRepository) ||
      !sha.test(upstream) || !sha.test(head)) throw new Error("Invalid release publication input");
  const version = versionFromTag(upstreamTag, prefix);
  if (version === null) throw new Error("Invalid upstream release tag");
  const tag = "v" + version;
  const remote = "https://github.com/" + upstreamRepository + ".git";
  if (remoteTagCommits(remote, [upstreamTag]).get(upstreamTag) !== upstream ||
      !listReleases(upstreamRepository, prefix, Date.now()).some(r => r.tag_name === upstreamTag)) {
    throw new Error("Upstream release or tag changed during validation");
  }
  git("fetch", "--no-tags", "origin", "refs/heads/" + target);
  if (git("rev-parse", "FETCH_HEAD") !== head) throw new Error("Validated fork head changed before release");
  git("merge-base", "--is-ancestor", upstream, head);
  const existing = remoteTagCommits("origin", [tag]).get(tag);
  if (existing) {
    if (existing !== head) throw new Error("Refusing to move existing release tag " + tag);
  } else {
    // Creating a tag without force is an atomic, immutable publication.
    git("push", "origin", head + ":refs/tags/" + tag);
  }
  const existingRelease = JSON.parse(gh("api", "--paginate", "--slurp",
    "repos/" + repository + "/releases?per_page=100")).flat().find(r => r.tag_name === tag);
  if (existingRelease) {
    if (existingRelease.draft || existingRelease.prerelease) throw new Error("Existing release is not stable");
    console.log("Stable release already exists: " + tag);
    return;
  }
  gh("release", "create", tag, "--repo", repository, "--verify-tag",
    "--title", tag,
    "--notes", "Validated downstream build of " + upstreamRepository + "@" + upstreamTag +
      " (" + upstream + "). Fork revision: " + head + ".");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "publish") publishRelease(...args);
  else throw new Error("Unknown release operation");
}
