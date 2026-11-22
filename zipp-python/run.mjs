// Execute a Python project in the pinned Zipp WebAssembly guest.
// Only declared files enter its VFS; only declared output paths can leave it.
import { createHash, randomUUID } from 'node:crypto';
import { globSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const release = JSON.parse(readFileSync(path.join(here, 'release.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const text = new TextDecoder('utf-8', {fatal: true});

function safeName(name) {
  if (typeof name !== 'string' || !name || name === '.' || name.includes('\\') ||
      name.includes('\0') || name.includes(':') || path.posix.isAbsolute(name) ||
      name.split('/').some(part => part === '.' || part === '..' || part.toLowerCase() === '.git' || !part)) {
    throw new Error('invalid checkout-relative path: ' + name);
  }
  return name;
}

function checkedPath(root, relative, allowMissing = false) {
  let current = root;
  for (const part of safeName(relative).split('/')) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error('refusing symlink: ' + relative);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return current;
}

function pattern(p) {
  safeName(p);
  // Patterns are checkout-relative and never permitted to reach Git metadata.
  if (path.posix.matchesGlob('.git/config', p) || path.posix.matchesGlob('.git', p)) {
    throw new Error('input/output patterns must not include .git: ' + p);
  }
  return p;
}

function snapshot(root, spec) {
  const names = new Set([safeName(spec.entry)]);
  for (const glob of spec.read ?? []) {
    const matches = globSync(pattern(glob), {cwd: root});
    if (!matches.length) throw new Error('required input did not match: ' + glob);
    for (const match of matches) names.add(match.split(path.sep).join('/'));
  }
  for (const glob of spec.optional ?? []) {
    for (const match of globSync(pattern(glob), {cwd: root})) names.add(match.split(path.sep).join('/'));
  }
  const files = new Map();
  for (const name of [...names].sort()) {
    const file = checkedPath(root, name);
    if (!lstatSync(file).isFile()) throw new Error('input must be a regular file: ' + name);
    files.set(name, readFileSync(file));
  }
  return files;
}

let runtime;
async function load() {
  if (!runtime) {
    const loader = readFileSync(path.join(here, 'vendor/zipp.mjs'));
    const engine = readFileSync(path.join(here, 'vendor/engine.wasm.br'));
    if (sha256(loader) !== release.loader_sha256 || sha256(engine) !== release.engine_sha256) {
      throw new Error('Zipp runtime checksum mismatch');
    }
    const {loadZipp} = await import(pathToFileURL(path.join(here, 'vendor/zipp.mjs')).href);
    runtime = await loadZipp(brotliDecompressSync(engine), {expectVersion: release.version});
    if (runtime.meta.commit !== release.commit || runtime.meta.variant !== 'javascript-python-base') {
      throw new Error('Zipp release identity mismatch');
    }
  }
  return runtime;
}

function drain(engine, failed, emit) {
  for (;;) {
    const rows = failed ? engine.takeFailedConsole() : engine.takeConsole();
    if (!rows.length) return;
    for (const row of rows) emit(row);
  }
}

function validateChanges(root, changes, allowed) {
  if (changes.version !== 1 || !Array.isArray(changes.changes)) throw new Error('invalid Zipp VFS report');
  const seen = new Set();
  return changes.changes.map(change => {
    const name = safeName(change.path);
    if (seen.has(name) || !allowed.some(p => path.posix.matchesGlob(name, p))) {
      throw new Error('undeclared or repeated guest write: ' + name);
    }
    seen.add(name);
    const destination = checkedPath(root, name, true);
    if (change.deleted === true && !Object.hasOwn(change, 'base64')) {
      return {name, destination, bytes: null};
    }
    if (typeof change.base64 !== 'string' || Object.hasOwn(change, 'deleted')) {
      throw new Error('invalid guest write payload: ' + name);
    }
    const bytes = Buffer.from(change.base64, 'base64');
    if (bytes.toString('base64') !== change.base64) throw new Error('invalid guest base64: ' + name);
    return {name, destination, bytes};
  });
}

function publish(root, changes) {
  for (const {name, destination, bytes} of changes) {
    // Recheck before touching the host: never follow symlinks.
    checkedPath(root, name, true);
    if (bytes === null) {
      rmSync(destination, {force: true});
      continue;
    }
    mkdirSync(path.dirname(destination), {recursive: true});
    const temporary = destination + '.zipp-' + randomUUID();
    writeFileSync(temporary, bytes, {flag: 'wx'});
    try {
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, {force: true});
    }
  }
}

function guestFile(name, bytes) {
  if (name.endsWith('.py')) return text.decode(bytes);
  if (!name.includes('.') && !name.includes('/')) return {base64: bytes.toString('base64')};
  try { return text.decode(bytes); }
  catch { return {base64: bytes.toString('base64')}; }
}

export async function runTask(root, spec, args, emit = row => {
  (row.stream === 'stderr' ? process.stderr : process.stdout).write(row.text + '\n');
}, stdin) {
  root = realpathSync(root);
  const allowed = (spec.write ?? []).map(pattern);
  const scratch = (spec.scratch ?? []).map(pattern);
  const files = snapshot(root, spec);
  if (spec.stdin !== undefined) {
    const name = safeName(spec.stdin);
    if (!Buffer.isBuffer(stdin) || files.has(name)) throw new Error('invalid or colliding stdin VFS input: ' + name);
    files.set(name, stdin);
  } else if (stdin !== undefined) {
    throw new Error('task has no declared stdin VFS input');
  }
  const inputs = Object.fromEntries([...files].map(([name, bytes]) => [
    name, guestFile(name, bytes),
  ]));
  const zipp = await load();
  const engine = new zipp.Engine();
  try {
    engine.setInstructionBudget(zipp.profile.limits.maxInstructionBudgetSteps);
    try {
      engine.initPythonProject(inputs, spec.entry, args);
    } catch (error) {
      drain(engine, true, emit);
      throw new Error(String(error));
    }
    drain(engine, false, emit);
    if (engine.takeHostRequests().length) throw new Error('unexpected guest host requests');
    const changes = validateChanges(root, JSON.parse(engine.pythonCall('__zipp_py_vfs_changed', [])), [...allowed, ...scratch]);
    publish(root, changes.filter(change => allowed.some(p => path.posix.matchesGlob(change.name, p))));
  } finally {
    engine.free();
  }
}

async function main() {
  const [root, manifest, task, ...args] = process.argv.slice(2);
  if (!task || !manifest || !root) throw new Error('usage: node run.mjs ROOT MANIFEST TASK [ARGS...]');
  const config = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!Object.hasOwn(config, task)) throw new Error('unknown Zipp task: ' + task);
  const spec = config[task];
  let stdin;
  if (spec.stdin !== undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error('stdin exceeds Zipp VFS input limit');
      chunks.push(chunk);
    }
    stdin = Buffer.concat(chunks);
  }
  await runTask(root, spec, args, undefined, stdin);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
