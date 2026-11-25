import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { decide } from '../policy-wasm/bridge.mjs';

const manifestUrl = 'https://static.rust-lang.org/dist/channel-rust-stable.toml';
const label = 'automation:rust-release';

// The release manifest, date/version validation, immutable issue marker,
// full review template, and existing-issue decision belong to Rust/WASI.
export function parseRelease(manifest, module) {
  return decide('stable-release-parse', {manifest}, module);
}

export function queueRelease(repository, release, gh = args => execFileSync('gh', args, {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}), module) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  // Validate before any GitHub write or read, including label creation.
  decide('stable-release-plan', {release, issues: []}, module);
  gh(['label', 'create', label, '--repo', repository, '--color', '8250df',
    '--description', 'Queued automatically when stable Rust changes', '--force']);
  const pages = JSON.parse(gh(['api', '--method', 'GET', '--paginate', '--slurp',
    'repos/' + repository + '/issues', '-f', 'state=all', '-f', 'labels=' + label, '-F', 'per_page=100']));
  const decision = decide('stable-release-plan', {release, issues: pages}, module);
  if (decision.state === 'existing') return {existing: decision.number};
  if (decision.state !== 'create') throw new Error('Unexpected WASI review decision');
  const url = gh(['issue', 'create', '--repo', repository, '--title',
    decision.title, '--label', label, '--body', decision.body]).trim();
  return {created: url};
}

export async function fetchRelease(fetchImpl = fetch, module) {
  const response = await fetchImpl(manifestUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error('Rust stable manifest HTTP ' + response.status);
  return parseRelease(await response.text(), module);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node rust-release-review.mjs OWNER/REPO');
  const release = await fetchRelease();
  console.log('Current stable Rust:', release.version, release.date);
  console.log(queueRelease(process.argv[2], release));
}
