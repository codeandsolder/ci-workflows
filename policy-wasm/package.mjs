import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadModule, sha256 } from './module.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifestPath = path.join(root, 'module.json');

async function sourceFiles(directory) {
  const entries = await readdir(path.join(root, directory), {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const name = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(name));
    else if (entry.isFile()) files.push(name);
    else throw new Error('unexpected non-file guest source: ' + name);
  }
  return files;
}

async function sourceDigest() {
  const files = ['Cargo.toml', 'Cargo.lock', ...await sourceFiles('src')].sort();
  const hash = createHash('sha256');
  for (const name of files) {
    hash.update(JSON.stringify([name, sha256(await readFile(path.join(root, name)))]));
  }
  return hash.digest('hex');
}

const [operation, compiled, compiler] = process.argv.slice(2);
if (process.argv.length !== 5 || !['pack', 'verify'].includes(operation) ||
    !/^nightly-\d{4}-\d{2}-\d{2}$/.test(compiler ?? '')) {
  throw new Error('usage: node package.mjs pack|verify COMPILED.wasm nightly-YYYY-MM-DD');
}

const raw = await readFile(compiled);
const source_sha256 = await sourceDigest();
if (operation === 'pack') {
  if (!WebAssembly.validate(raw)) throw new Error('invalid WebAssembly module');
  const manifest = {format: 1, compiler, source_sha256, wasm_sha256: sha256(raw)};
  await writeFile(path.join(root, 'module.wasm.gz'), gzipSync(raw, {level: 9}));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log('Packaged policy from ' + compiler + ': ' + manifest.wasm_sha256);
} else {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await loadModule(manifestPath);
  if (manifest.source_sha256 !== source_sha256) {
    throw new Error('bundled policy is stale: regenerate it from the current guest sources');
  }
  if (manifest.compiler === compiler) {
    if (manifest.wasm_sha256 !== sha256(raw)) {
      throw new Error('bundled policy differs from the same compiler and source build');
    }
    console.log('Bundled module is byte-identical to the provider build.');
  } else {
    console.log('Bundled module was built with ' + manifest.compiler +
      '; source digest verified; validate both modules against the policy fixtures.');
  }
}
