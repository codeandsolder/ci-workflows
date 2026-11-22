import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
import { realpathSync } from 'node:fs';

const [modulePath, policy, root] = process.argv.slice(2);
if (policy !== 'concurrency' || !modulePath || !root || process.argv.length !== 5) {
  throw new Error('usage: node run.mjs MODULE.wasm concurrency ROOT');
}
const wasi = new WASI({
  version: 'preview1',
  args: ['ci-policy', policy, '/workspace'],
  preopens: { '/workspace': realpathSync(root) },
  returnOnExit: true,
});
const module = await WebAssembly.compile(await readFile(modulePath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
