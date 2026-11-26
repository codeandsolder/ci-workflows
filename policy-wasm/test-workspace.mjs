// Shared host-filesystem fixtures for the real compiled policy tests.
import {mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

export function workspace(t, prefix) {
  const temporary = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(temporary, {recursive: true, force: true}));
  // macOS exposes /var through /private/var; match the WASI host bridge.
  return realpathSync(temporary);
}

export function write(root, relative, contents) {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), {recursive: true});
  writeFileSync(file, contents, 'utf8');
}
