import { execFileSync } from "node:child_process";

// Preserve automation configuration and CI-only entrypoints from the reviewed
// target, even when ordinary source updates can be published automatically.
export const CHECKPOINT = ".github/upstream-reconciliation/reviewed-source-sha";
export function isCiPath(path) {
  if (path === CHECKPOINT) return false;
  return /^(?:(?:\.github|\.circleci|\.buildkite|\.ci|ci|\.gitlab|\.woodpecker)(?:\/|$)|\.cargo\/config(?:\.toml)?$|scripts\/ci(?:[/._-]|$))/.test(path) ||
    /^(?:\.gitlab-ci\.ya?ml|\.travis\.yml|\.drone\.yml|\.woodpecker\.ya?ml|appveyor\.ya?ml|azure-pipelines(?:[.-][^/]*)?\.ya?ml|bitbucket-pipelines\.ya?ml|Jenkinsfile(?:\.[^/]*)?|buildspec\.ya?ml|rust-toolchain(?:\.toml)?|(?:\.?)clippy\.toml|(?:\.?)rustfmt\.toml|deny\.toml|renovate\.json5?|\.renovaterc(?:\.json5?)?)$/.test(path);
}
function names(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).split("\0").filter(Boolean);
}
export function changedCiPaths(left, right) {
  return names("diff", "--no-renames", "--name-only", "-z", left, right).filter(isCiPath);
}
export function trackedCiPaths(...refs) {
  const paths = new Set(names("ls-files", "-z"));
  for (const ref of refs) {
    for (const path of names("ls-tree", "-r", "--name-only", "-z", ref)) paths.add(path);
  }
  return [...paths].filter(isCiPath);
}
