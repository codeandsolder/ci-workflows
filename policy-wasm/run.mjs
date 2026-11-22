import { loadModule } from './module.mjs';
import { WASI } from 'node:wasi';
import { realpathSync } from 'node:fs';

const [modulePath, policy, root, ...options] = process.argv.slice(2);
if (!['concurrency', 'sccache'].includes(policy) || !modulePath || !root ||
    options.length > (policy === 'sccache' ? 1 : 0)) {
  throw new Error('usage: node run.mjs MODULE concurrency|sccache ROOT [STRICT_REF]');
}
const wasi = new WASI({
  version: 'preview1',
  args: ['ci-policy', policy, '/workspace', ...options],
  preopens: { '/workspace': realpathSync(root) },
  returnOnExit: true,
});
const module = await WebAssembly.compile(await loadModule(modulePath));
const instance = await WebAssembly.instantiate(module, wasi.getImportObject());
process.exitCode = wasi.start(instance);
