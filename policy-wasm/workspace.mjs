import { lstatSync, readlinkSync, realpathSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const mount = '/workspace';
const utf8 = new TextDecoder('utf-8', {fatal: true});
const encoder = new TextEncoder();

function missing(error) {
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

// Preserve symlink/.. ordering: path.resolve() before following symlinks
// would incorrectly resolve a different file. Missing final components
// retain their checkout-relative identity.
function resolve(root, candidate) {
  let parts;
  if (candidate === mount || candidate.startsWith(mount + '/')) {
    parts = candidate.slice(mount.length).split('/');
  } else if (path.isAbsolute(candidate) && inside(root, candidate)) {
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (candidate !== root && !candidate.startsWith(prefix)) return null;
    parts = candidate.slice(root.length).split(path.sep);
  } else {
    return null;
  }
  let current = root;
  let links = 0;
  let pending = parts.reverse();
  while (pending.length) {
    const part = pending.pop();
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (current === root) return null;
      current = path.dirname(current);
      continue;
    }
    if (part.includes('\0') || part.includes(path.sep) || (path.sep === '\\' && part.includes(':'))) {
      return null;
    }
    const next = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(next);
    } catch (error) {
      if (!missing(error)) throw error;
      current = next;
      continue;
    }
    if (stat.isSymbolicLink()) {
      if (++links > 40) return null;
      const target = readlinkSync(next);
      let segments;
      if (path.isAbsolute(target)) {
        const prefix = root.endsWith(path.sep) ? root : root + path.sep;
        if (target !== root && !target.startsWith(prefix)) return null;
        segments = target.slice(root.length).split(path.sep);
        current = root;
      } else {
        segments = target.split(path.sep);
      }
      pending.push(...segments.reverse());
    } else {
      current = next;
    }
  }
  let kind = 'm';
  try {
    const stat = statSync(current);
    kind = stat.isFile() ? 'f' : stat.isDirectory() ? 'd' : 'o';
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (!inside(root, current)) return null;
  const relative = path.relative(root, current).split(path.sep).join('/');
  return kind + mount + (relative ? '/' + relative : '');
}

export function workspace(root) {
  const canonical = realpathSync(root);
  const cached = new Map();
  const lookup = (candidate) => {
    if (!cached.has(candidate)) cached.set(candidate, resolve(canonical, candidate));
    return cached.get(candidate);
  };
  return {
    root: canonical,
    workflowPaths() {
      let entries;
      try {
        entries = readdirSync(path.join(canonical, '.github', 'workflows'));
      } catch (error) {
        if (missing(error)) return [];
        throw error;
      }
      return entries.filter((name) => /\.(ya?ml)$/.test(name))
        .map((name) => mount + '/.github/workflows/' + name)
        .filter((file) => lookup(file)?.startsWith('f'))
        .sort();
    },
    imports(getMemory) {
      return {
        resolve_path(input, inputLength, output, capacity) {
          const memory = new Uint8Array(getMemory().buffer);
          const valid = (start, length) => start >= 0 && length >= 0 && start + length <= memory.length;
          if (!valid(input, inputLength) || !valid(output, capacity)) throw new Error('invalid workspace ABI buffer');
          const candidate = utf8.decode(memory.subarray(input, input + inputLength));
          const resolved = lookup(candidate);
          if (resolved === null) return 0;
          const bytes = encoder.encode(resolved);
          if (capacity > 0) {
            if (capacity !== bytes.length) throw new Error('workspace ABI size mismatch');
            memory.set(bytes, output);
          }
          return bytes.length;
        },
      };
    },
  };
}
