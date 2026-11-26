import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseUrl(pin) {
  if (!/^[a-f0-9]{40}$/.test(pin.commit) || !/^[a-f0-9]{64}$/.test(pin.sha256)) {
    throw new Error('Invalid pinned cargo-anoint release');
  }
  return 'https://github.com/codeandsolder/cargo-anoint/releases/download/ci-' + pin.commit + '/cargo-anoint-linux-x86_64';
}

export function verifyBinary(bytes, sha256) {
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new Error('cargo-anoint binary checksum mismatch');
  }
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Pinned cargo-anoint binary requires Linux x86_64');
  }
  const pin = JSON.parse(readFileSync(new URL('./anoint-release.json', import.meta.url), 'utf8'));
  const response = await fetch(releaseUrl(pin), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('cargo-anoint release download failed: HTTP ' + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  verifyBinary(bytes, pin.sha256);
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'cargo-anoint-'));
  const binary = join(directory, 'cargo-anoint');
  try {
    writeFileSync(binary, bytes, { mode: 0o755, flag: 'wx' });
    appendFileSync(process.env.GITHUB_OUTPUT, 'binary=' + binary + '\n');
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
