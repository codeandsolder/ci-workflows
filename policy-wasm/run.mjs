import { loadModule } from './module.mjs';
import { WASI } from 'node:wasi';
import { workspace } from './workspace.mjs';

const [modulePath, policy, root, ...options] = process.argv.slice(2);
if (!['concurrency', 'sccache'].includes(policy) || !modulePath || !root ||
    options.length > (policy === 'sccache' ? 1 : 0)) {
  throw new Error('usage: node run.mjs MODULE concurrency|sccache ROOT [STRICT_REF]');
}
const host = workspace(root);
const args = ['ci-policy', policy, '/workspace'];
if (policy === 'sccache') args.push(options[0] ?? '');
args.push(...host.workflowPaths());
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
