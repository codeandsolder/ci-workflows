import { loadModule } from './module.mjs';
import { WASI } from 'node:wasi';
import { workspace } from './workspace.mjs';
import path from 'node:path';

const [modulePath, policy, root, ...options] = process.argv.slice(2);
if (!modulePath || !root || !(
  (policy === 'concurrency' && options.length === 0) ||
  (policy === 'sccache' && options.length <= 1) ||
  (policy === 'clones' && options.length === 3)
)) {
  throw new Error('usage: node run.mjs MODULE concurrency ROOT | sccache ROOT [STRICT_REF] | clones ROOT SCAN_ROOT PROD_TOKENS TEST_TOKENS');
}
const host = workspace(root);
const args = ['ci-policy', policy, '/workspace'];
if (policy === 'clones') {
  const [scan, production, testing] = options;
  const resolved = host.lookup(path.isAbsolute(scan) ? scan : '/workspace/' + scan);
  if (!resolved?.startsWith('d')) throw new Error('scan root must be a checkout directory');
  args.push(resolved.slice(1), production, testing);
} else {
  if (policy === 'sccache') args.push(options[0] ?? '');
  args.push(...host.workflowPaths());
}
const wasi = new WASI({
  version: 'preview1',
  args,
  preopens: { '/workspace': host.root },
  returnOnExit: true,
});
const module = await WebAssembly.compile(await loadModule(modulePath));
const instance = await WebAssembly.instantiate(module, {
  ...wasi.getImportObject(),
  ci_workspace: host.imports(() => instance.exports.memory),
});
process.exitCode = wasi.start(instance);
