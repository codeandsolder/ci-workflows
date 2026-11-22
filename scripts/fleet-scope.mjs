// Contribution-only forks are not maintained fleet repositories.
const contributionOnly = new Set([
  'codeandsolder/anubis',
  'codeandsolder/hayro',
  'codeandsolder/oxc',
]);

export function isContributionOnly(fullName) {
  return contributionOnly.has(fullName.toLowerCase());
}

export function isMaintainedRepo(repo) {
  return !repo.archived && !repo.disabled &&
    repo.full_name.toLowerCase().startsWith('codeandsolder/') &&
    !isContributionOnly(repo.full_name);
}
