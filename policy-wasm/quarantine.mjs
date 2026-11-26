// Native IO boundary: Git and HTTPS exist on the host, not in WASI.
// The portable guest owns lock parsing, union comparison, consolidation
// checks and the release-age decision.
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workspace } from './workspace.mjs';

const utf8 = new TextDecoder('utf-8', {fatal: true});
const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

function command(root, bin, args, input) {
  const result = spawnSync(bin, args, {cwd: root, input, maxBuffer: 128 * 1024 * 1024});
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(bin + ' ' + args.join(' ') + ' failed: ' + result.stderr.toString('utf8'));
  }
  return utf8.decode(result.stdout);
}

function git(root, ...args) {
  return command(root, 'git', args);
}

function isLock(file) {
  return path.posix.basename(file) === 'Cargo.lock';
}

function relative(root, file) {
  const rel = path.relative(root, realpathSync(file)).split(path.sep).join('/');
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

function normalizedSelector(selector) {
  if (selector === 'auto') return selector;
  if (path.isAbsolute(selector) || selector.includes('\\') || selector.includes('\0')) {
    throw new Error('lockfile must be repository-relative');
  }
  const normalized = path.posix.normalize(selector);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('lockfile must be repository-relative');
  }
  return normalized;
}

function checkedFile(host, file) {
  const full = path.join(host.root, file);
  try {
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('refusing symlinked tracked lockfile ' + file);
    if (!stat.isFile()) return null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
  if (host.lookup('/workspace/' + file) !== 'f/workspace/' + file) {
    throw new Error('lockfile path escapes or aliases checkout: ' + file);
  }
  return full;
}

function removedManifest(host, file) {
  const manifest = path.posix.join(path.posix.dirname(file), 'Cargo.toml');
  const full = checkedFile(host, manifest);
  if (full === null) return null;
  const entry = {manifest, workspace_lock: null, members: []};
  try {
    const metadata = JSON.parse(command(host.root, 'cargo', [
      'metadata', '--manifest-path', full, '--format-version', '1', '--no-deps', '--offline', '--locked',
    ]));
    const root = relative(host.root, metadata.workspace_root);
    const members = new Set(metadata.workspace_members);
    if (root !== null) entry.workspace_lock = path.posix.join(root, 'Cargo.lock');
    entry.members = metadata.packages
      .filter((pkg) => members.has(pkg.id))
      .map((pkg) => relative(host.root, pkg.manifest_path))
      .filter((member) => member !== null);
  } catch {
    // An unproven consolidation is rejected by the guest.
  }
  return entry;
}

export function gather(root, ref, selector) {
  const host = workspace(root);
  selector = normalizedSelector(selector);
  const commit = git(host.root, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').trim();
  const baseline = new Set(git(host.root, 'ls-tree', '-r', '--name-only', '-z', commit).split('\0'));
  const tracked = selector === 'auto'
    ? [...new Set(git(host.root, 'ls-files', '--cached', '-z').split('\0'))].filter(isLock)
    : [selector];
  const before = Object.fromEntries([...baseline]
    .filter((file) => selector === 'auto' ? isLock(file) : file === selector)
    .map((file) => [file, git(host.root, 'show', commit + ':' + file)]));
  const after = {};
  for (const file of tracked) {
    const full = checkedFile(host, file);
    if (full !== null) Object.defineProperty(after, file, {value: utf8.decode(readFileSync(full)), enumerable: true});
  }
  const removed = Object.fromEntries(Object.keys(before)
    .filter((file) => selector === 'auto' && !Object.hasOwn(after, file))
    .map((file) => [file, removedManifest(host, file)])
    .filter(([, manifest]) => manifest !== null));
  return {selector, before, after, removed_manifests: removed};
}

export function guest(module, root, mode, input) {
  return JSON.parse(command(root, process.execPath, [runner, module, mode, root], JSON.stringify(input)));
}

function publication(timestamp) {
  if (typeof timestamp !== 'string') return {kind: 'missing'};
  // Round publication up to the nearest millisecond (never release early
  // because crates.io returned submillisecond precision).
  const match = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.(\d+))?(?:Z|[+-]\d\d:\d\d)$/.exec(timestamp);
  if (!match) return {kind: 'failed', message: 'invalid publication timestamp'};
  const time = Date.parse(timestamp);
  const wallClock = new Date(timestamp.slice(0, 19) + 'Z');
  if (!Number.isFinite(time) || !Number.isFinite(wallClock.valueOf()) ||
      wallClock.toISOString().slice(0, 19) !== timestamp.slice(0, 19)) return {kind: 'failed', message: 'invalid publication timestamp'};
  return {kind: 'found', time_ms: time + (/[1-9]/.test((match[1] ?? '').slice(3)) ? 1 : 0), timestamp};
}

// Keep one in-flight request, pace requests to the public crates.io API, and
// respect a server-wide cooldown even after an individual crate exhausts retries.
// Never substitute a guessed timestamp or an untrusted persistent PR cache.
const defaultTransport = {
  clock: Date.now,
  sleep: delay,
  spacingMs: 1_000,
  budgetMs: 8 * 60_000,
};

function retryAfterMs(value, now) {
  if (typeof value !== 'string' || !value.trim()) return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) * 1_000 : NaN;
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export async function lookupPublications(packages, request = fetch, transport = defaultTransport) {
  const {clock, sleep, spacingMs, budgetMs} = transport;
  const deadline = clock() + budgetMs;
  let nextRequest = clock();
  const names = new Map();
  for (const pkg of packages) {
    if (!names.has(pkg.name)) names.set(pkg.name, new Set());
    names.get(pkg.name).add(pkg.version);
  }
  const output = new Map();
  for (const [name, versions] of names) {
    let found;
    try {
      let response;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const wait = Math.max(0, nextRequest - clock());
        if (clock() + wait >= deadline) throw new Error('crates.io request budget exhausted');
        if (wait) await sleep(wait);
        const remaining = deadline - clock();
        if (remaining <= 0) throw new Error('crates.io request budget exhausted');
        nextRequest = clock() + spacingMs;
        try {
          response = await request('https://crates.io/api/v1/crates/' + encodeURIComponent(name), {
            headers: {'Accept': 'application/json', 'User-Agent': 'codeandsolder-ci-release-quarantine/1.0'},
            signal: AbortSignal.timeout(Math.min(30_000, remaining)),
          });
        } catch (error) {
          nextRequest = Math.max(nextRequest, clock() + 1_000 * 2 ** attempt);
          if (attempt === 3) throw error;
          continue;
        }
        if (response.ok) break;
        const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
        if (retryable) {
          const serverWait = retryAfterMs(response.headers?.get('Retry-After'), clock());
          nextRequest = Math.max(nextRequest, clock() + Math.max(serverWait, 1_000 * 2 ** attempt));
        }
        if (!retryable || attempt === 3) throw new Error('HTTP ' + response.status);
        // Release connections before retrying rather than retaining an unread body.
        await response.body?.cancel();
      }
      const payload = await response.json();
      if (!Array.isArray(payload.versions)) throw new Error('invalid crates.io response');
      const records = new Map(payload.versions.map((item) => [item.num, item.created_at]));
      found = [...versions].map((version) => [version, publication(records.get(version))]);
    } catch (error) {
      found = [...versions].map((version) => [version, {kind: 'failed', message: String(error)}]);
    }
    output.set(name, Object.fromEntries(found));
  }
  return Object.fromEntries(output);
}

export async function quarantine(module, root, ref, selector, hours, request = fetch, now, transport = defaultTransport) {
  if (!Number.isSafeInteger(hours) || hours < 0) throw new Error('hours must be a non-negative integer');
  const packages = guest(module, root, 'quarantine-diff', gather(root, ref, selector));
  if (packages.length === 0) return {issues: [], count: 0, metadataUnavailable: false};
  const checkedAt = now ?? Date.now();
  const publications = await lookupPublications(packages, request, transport);
  const metadataUnavailable = packages.some(({name, version}) => publications[name]?.[version]?.kind !== 'found');
  const issues = guest(module, root, 'quarantine-age', {now_ms: checkedAt, hours, packages, publications});
  return {issues, count: packages.length, metadataUnavailable};
}

async function main() {
  const [module, ref, hours, selector] = process.argv.slice(2);
  if (process.argv.length !== 6 || !module || !ref || !/^\d+$/.test(hours ?? '') || !selector) {
    throw new Error('usage: node quarantine.mjs MODULE BASE_REF HOURS LOCKFILE');
  }
  const result = await quarantine(path.resolve(module), process.cwd(), ref, selector, Number(hours));
  if (result.issues.length) {
    console.error(result.metadataUnavailable
      ? 'Cargo release-age quarantine cannot verify authoritative publication metadata:'
      : 'Cargo release-age quarantine is still active:');
    for (const issue of result.issues) console.error('- ' + issue);
    process.exitCode = result.metadataUnavailable ? 11 : 10;
  } else {
    console.log('Cargo release-age quarantine passed for ' + result.count +
      ' newly introduced crates.io package versions across ' +
      (selector === 'auto' ? 'all tracked Cargo.lock files' : selector) + '.');
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error('Cargo release-age quarantine cannot validate lockfiles: ' + error.message);
    process.exitCode = 1;
  });
}
