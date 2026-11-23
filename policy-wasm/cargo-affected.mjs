// Cargo/Git process access stays native; dependency decisions execute in shared WASI.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspace } from './workspace.mjs';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const utf8 = new TextDecoder('utf-8', {fatal: true});

function processCommand(root, executable, args, input, capture = true) {
  const result = spawnSync(executable, args, {
    cwd: root,
    input,
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(executable + ' ' + args.join(' ') + ' failed (exit ' + result.status + '): ' +
      (result.stderr ? utf8.decode(result.stderr) : ''));
  }
  return capture ? utf8.decode(result.stdout) : '';
}

function guest(module, root, operation, input) {
  const output = processCommand(root, process.execPath,
    [runner, module, operation, root], JSON.stringify(input));
  return JSON.parse(output);
}

function policyFile(root, config) {
  if (!config || path.isAbsolute(config) || config.includes('\0')) {
    throw new Error('policy config must be a checkout-relative file');
  }
  const host = workspace(root);
  const expected = '/workspace/' + config.replaceAll('\\', '/');
  if (host.lookup(expected) !== 'f' + expected) {
    throw new Error('policy config must be an ordinary file in the checkout');
  }
  return path.join(host.root, config);
}

function changedPaths(root, base, head) {
  if (!base || !head || !/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head)) {
    throw new Error('PR requires exact base and head commit hashes');
  }
  const result = processCommand(root, 'git',
    ['diff', '--no-renames', '--name-only', '-z', '--diff-filter=ACMRTD',
      base + '...' + head, '--']);
  return result.split('\0').filter(Boolean);
}

export function plan(module, root, config, event, base, head) {
  const host = realpathSync(root);
  const policy = JSON.parse(readFileSync(policyFile(host, config), 'utf8'));
  const metadata = JSON.parse(processCommand(host, 'cargo',
    ['metadata', '--format-version', '1', '--no-deps']));
  const changed = event === 'pull_request' ? changedPaths(host, base, head) : [];
  return guest(module, host, 'cargo-affected-plan', {event, changed, metadata, policy});
}

export function expand(module, root, packages, command) {
  const result = guest(module, realpathSync(root), 'cargo-affected-args',
    {packages, command});
  if (!Array.isArray(result) || result.length < 3 || result[0] !== 'cargo') {
    throw new Error('WASM returned an invalid Cargo command');
  }
  return result;
}

function writeOutputs(file, result) {
  const values = {
    affected_packages: result.affected_packages,
    has_code: result.has_code,
    run_full: result.run_full,
    extra_flags: result.extra_flags,
    test_matrix: result.test_matrix,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) throw new Error('WASM omitted required output ' + key);
    appendFileSync(file, key + '=' +
      (typeof value === 'object' ? JSON.stringify(value) : String(value)) + '\n');
  }
}

function main() {
  const [mode, module, root, ...args] = process.argv.slice(2);
  if (mode === 'plan' && args.length === 5) {
    const result = plan(module, root, ...args.slice(0, 4));
    const output = args[4];
    if (!output) throw new Error('GitHub outputs file is required');
    writeOutputs(output, result);
    console.log('Cargo CI scope: ' + (result.run_full ? 'full' : 'affected') + '; ' + result.reason);
    console.log('Packages (' + result.affected_packages.length + '): ' +
      (result.affected_packages.join(', ') || 'none'));
  } else if (mode === 'run' && args.length === 2) {
    const packages = JSON.parse(args[0]);
    const command = JSON.parse(args[1]);
    const argv = expand(module, root, packages, command);
    console.log('Running:', argv.join(' '));
    processCommand(root, argv[0], argv.slice(1), undefined, false);
  } else {
    throw new Error('usage: node cargo-affected.mjs plan MODULE ROOT CONFIG EVENT BASE HEAD OUTPUT | run MODULE ROOT PACKAGES_JSON COMMAND_JSON');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
