#!/usr/bin/env node
// Run source-only quality checks against the exact Git-tracked manifest.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';

const [module, manifestPath, executable, extra] = process.argv.slice(2);
if (!module || !manifestPath || !executable) {
  console.error('usage: node languages/run.mjs MODULE MANIFEST EXECUTABLE [OPTION]');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const sourceRoot = process.cwd();
if (manifest.format !== 1) throw new Error('Unexpected source manifest format');
function verify(paths) {
  if (!Array.isArray(paths)) throw new Error('Missing source array in manifest');
  return paths.map(path => {
    if (typeof path !== 'string' || !path || path.startsWith('/') ||
        path.split('/').some(part => part === '..' || part === '.') ||
        !resolve(sourceRoot, path).startsWith(sourceRoot + sep)) {
      throw new Error('Unsafe tracked source path: ' + String(path));
    }
    const actual = realpathSync(resolve(sourceRoot, path));
    if (!actual.startsWith(sourceRoot + sep) || !statSync(actual).isFile()) {
      throw new Error('Tracked source escapes checkout: ' + path);
    }
    return path;
  });
}
function execute(bin, args, { silent = false } = {}) {
  const result = spawnSync(bin, args, {
    cwd: sourceRoot, stdio: silent ? ['ignore', 'ignore', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
const batch = (paths, amount = 80) =>
  Array.from({ length: Math.ceil(paths.length / amount) }, (_, i) =>
    paths.slice(i * amount, (i + 1) * amount));
switch (module) {
  case 'shellcheck': {
    const files = verify(manifest.shell).filter(path => !path.endsWith('.zsh'));
    for (const group of batch(files)) execute(executable, ['--severity=warning', '--', ...group]);
    const zsh = manifest.shell.length - files.length;
    if (zsh > 0) console.log('ShellCheck cannot analyze ' + zsh + ' Zsh file(s); shfmt parses those.');
    break;
  }
  case 'shfmt': {
    const files = verify(manifest.shell);
    const formatting = extra === '--format';
    for (const path of files) execute(executable, formatting ? ['--diff', './' + path] : ['./' + path], { silent: !formatting });
    break;
  }
  case 'javascript': {
    const files = verify([...manifest.javascript, ...manifest.typescript]);
    for (const group of batch(files)) execute(executable, ['-D', 'correctness', '--', ...group]);
    break;
  }
  default: throw new Error('Unknown source module: ' + module);
}
