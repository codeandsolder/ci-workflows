import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const manifestUrl = 'https://static.rust-lang.org/dist/channel-rust-stable.toml';
const label = 'automation:rust-release';

function validateRelease(version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid stable Rust version');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid stable Rust release date');
  const time = new Date(date);
  if (!Number.isFinite(time.valueOf()) || time.toISOString().slice(0, 10) !== date) {
    throw new Error('Invalid stable Rust release date');
  }
}

// Read only the two fields in Rust's published channel manifest. Require
// exactly one of each in its documented section; never match target versions.
export function parseRelease(manifest) {
  const dates = [], versions = [];
  let section = '', rustSections = 0;
  for (const line of manifest.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      section = header[1];
      if (section === 'pkg.rust') rustSections++;
      continue;
    }
    if (section === '') {
      const field = line.match(/^\s*date\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
      if (field) dates.push(field[1]);
    } else if (section === 'pkg.rust') {
      const field = line.match(/^\s*version\s*=\s*"(\d+\.\d+\.\d+)(?:\s+[^"]+)?"\s*(?:#.*)?$/);
      if (field) versions.push(field[1]);
    }
  }
  if (dates.length !== 1 || versions.length !== 1 || rustSections !== 1) {
    throw new Error('Unexpected Rust stable channel manifest');
  }
  const [version] = versions, [date] = dates;
  validateRelease(version, date);
  return { version, date };
}

export function reviewBody(version) {
  return [
    '<!-- rust-stable-' + version + ' -->',
    '<!-- automation-queue:rust-release -->',
    '',
    'Rust **' + version + '** is now the stable toolchain.',
    '',
    'Do a complete repository refresh against this release, not merely a version-string update:',
    '',
    '- Read the official Rust ' + version + ' announcement and detailed release notes/changelog.',
    '- Review language, standard-library, rustc, Cargo, Clippy, rustfmt, platform and tooling changes.',
    '- Review Rust code, manifests, lockfiles, CI, build/release tooling, skills, policy checks, documentation, examples and tests where present.',
    '- Adopt useful newly-stable features and best practices; remove obsolete workarounds.',
    '- Preserve the repository toolchain policy (including shared quarantined nightly and any intentional MSRV/release exceptions). Let the canonical toolchain update mechanism own pins.',
    '- Run the relevant CI-equivalent checks and fix fallout.',
    '- If no changes are justified, document what was reviewed and close this issue as a no-op.',
    '',
    'This issue is generated automatically. A ChatGPT maintenance automation is expected to implement it.',
  ].join('\n');
}

export function queueRelease(repository, release, gh = args => execFileSync('gh', args, {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
})) {
  const { version, date } = release;
  validateRelease(version, date);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  gh(['label', 'create', label, '--repo', repository, '--color', '8250df',
    '--description', 'Queued automatically when stable Rust changes', '--force']);
  const pages = JSON.parse(gh(['api', '--method', 'GET', '--paginate', '--slurp',
    'repos/' + repository + '/issues', '-f', 'state=all', '-f', 'labels=' + label, '-F', 'per_page=100']));
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error('Invalid issue inventory');
  const marker = '<!-- rust-stable-' + version + ' -->';
  const existing = pages.flat().find(issue => !('pull_request' in issue) &&
    typeof issue.body === 'string' && issue.body.includes(marker));
  if (existing) return { existing: existing.number };
  const url = gh(['issue', 'create', '--repo', repository, '--title',
    'Rust ' + version + ': full best-practices refresh', '--label', label, '--body', reviewBody(version)]).trim();
  return { created: url };
}

export async function fetchRelease(fetchImpl = fetch) {
  const response = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Rust stable manifest HTTP ' + response.status);
  return parseRelease(await response.text());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node rust-release-review.mjs OWNER/REPO');
  const release = await fetchRelease();
  console.log('Current stable Rust:', release.version, release.date);
  console.log(queueRelease(process.argv[2], release));
}
