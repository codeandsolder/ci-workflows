// Shared policy transport. Native hosts own process and API I/O; the WASM
// guest owns every portable policy decision. Use one spawn per batch.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const packaged = fileURLToPath(new URL('./module.json', import.meta.url));

export function decide(policy, payload, module = packaged) {
  const result = spawnSync(process.execPath, [runner, module, policy, root], {
    input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('shared Rust/WASI ' + policy + ' policy failed: ' + result.stderr);
  }
  return JSON.parse(result.stdout);
}
