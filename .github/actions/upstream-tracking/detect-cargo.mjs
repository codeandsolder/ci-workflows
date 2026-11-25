import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Detect tracked Cargo manifests from the exact checked-out candidate. Git
// remains the source of file identity: untracked generation scratch must not
// activate, or disable, a language-specific publication gate.
export function trackedCargoManifests(root) {
  const data = execFileSync('git', [
    '-C', root, 'ls-files', '-z', '--', 'Cargo.toml', ':(glob)**/Cargo.toml',
  ], { encoding: 'utf8' });
  return data.split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, output] = process.argv.slice(2);
  if (!root || !output || process.argv.length !== 4) {
    throw new Error('usage: detect-cargo.mjs CHECKED_OUT_CANDIDATE GITHUB_OUTPUT_PATH');
  }
  const manifests = trackedCargoManifests(root);
  const rust = manifests.length > 0;
  appendFileSync(output, 'rust=' + rust + '\n');
  console.log('Tracked Cargo manifests: ' + manifests.length + '; Rust gate: ' + rust);
}
