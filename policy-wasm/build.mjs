// Build the release WASI policy identically on any checkout location.
// The nightly location-detail setting removes source-root paths from
// compiled caller-location metadata; keep sccache and the managed toolchain.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const [targetDir] = process.argv.slice(2);
if (process.argv.length !== 3 || !targetDir || !path.isAbsolute(targetDir)) {
  throw new Error('usage: node policy-wasm/build.mjs ABSOLUTE_TARGET_DIR');
}
const argv = [
  '--config', 'build.rustflags=["-Zlocation-detail=none"]',
  'build',
  '--manifest-path', path.join(root, 'Cargo.toml'),
  '--locked', '--release', '--target', 'wasm32-wasip1',
  '--target-dir', targetDir,
];
const result = spawnSync('cargo', argv, {stdio: 'inherit'});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error('the managed Cargo release build failed (status ' + result.status + ')');
}
