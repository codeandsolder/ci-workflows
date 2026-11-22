import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function loadModule(filename) {
  if (path.extname(filename) === '.wasm') {
    // Direct compiler output is used only by provider validation.
    return readFile(filename);
  }
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  if (manifest.format !== 1 || !/^[a-f0-9]{64}$/.test(manifest.wasm_sha256 ?? '')) {
    throw new Error('invalid CI policy module manifest');
  }
  const bytes = gunzipSync(await readFile(path.join(path.dirname(filename), 'module.wasm.gz')));
  if (sha256(bytes) !== manifest.wasm_sha256) {
    throw new Error('CI policy module digest mismatch');
  }
  return bytes;
}
