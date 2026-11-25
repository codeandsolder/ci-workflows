#!/usr/bin/env node
// Discover caller Git-tracked sources, never generated CI checkout files.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, openSync, readSync, closeSync, writeFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

const [rootArgument, manifestArgument, outputArgument] = process.argv.slice(2);
if (!rootArgument || !manifestArgument) {
  console.error('Usage: node languages/detect.mjs <caller-root> <manifest-json> [github-output]');
  process.exit(2);
}
const root = resolve(rootArgument);
const tracked = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--full-name', '-z'], {
  maxBuffer: 64 * 1024 * 1024,
}).toString('utf8').split('\0').filter(Boolean);

const includesFile = path => {
  const actual = resolve(root, path);
  if (!actual.startsWith(root + sep)) {
    throw new Error('Git listed a path outside the caller checkout: ' + path);
  }
  return existsSync(actual) && lstatSync(actual).isFile();
};
const files = tracked.filter(includesFile);
const matches = predicate => files.filter(predicate);
const java = matches(path => path.endsWith('.java'));
const rust = matches(path => path.endsWith('.rs'));
const javascript = matches(path => /\.(?:js|mjs|cjs|jsx)$/i.test(path));
const typescript = matches(path => /\.(?:ts|mts|cts|tsx)$/i.test(path));
const python = matches(path => /\.(?:py|pyi|pyw)$/i.test(path));
const wgsl = matches(path => path.endsWith('.wgsl'));
const knownShell = /\.(?:sh|bash|zsh)$/i;
function shebangShell(path) {
  if (knownShell.test(path) || /\.[^/]+$/.test(basename(path))) return false;
  const fd = openSync(resolve(root, path), 'r');
  try {
    const bytes = Buffer.alloc(256);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return /^#![^\n]*(?:\/|\s)(?:ba|da|k|z)?sh(?:\s|$)/.test(bytes.toString('utf8', 0, count).split('\n', 1)[0]);
  } finally {
    closeSync(fd);
  }
}
const shell = matches(path => knownShell.test(path) || shebangShell(path));
const report = {
  format: 1, java, rust, javascript, typescript, python, wgsl, shell,
  has_java: java.length > 0, has_rust: rust.length > 0,
  has_javascript: javascript.length + typescript.length > 0,
  has_python: python.length > 0, has_wgsl: wgsl.length > 0, has_shell: shell.length > 0,
};
writeFileSync(resolve(manifestArgument), JSON.stringify(report) + '\n');
const lines = ['java', 'rust', 'javascript', 'typescript', 'python', 'wgsl', 'shell'].flatMap(lang => {
  const key = lang === 'typescript' ? 'typescript' : lang;
  return ['has_' + key + '=' + (lang === 'javascript' ? report.has_javascript : report['has_' + key] ?? report[lang].length > 0),
    key + '_count=' + report[lang].length];
});
if (outputArgument) {
  writeFileSync(resolve(outputArgument), lines.join('\n') + '\n', { flag: 'a' });
}
console.log('Tracked sources: ' + ['java', 'rust', 'javascript', 'typescript', 'python', 'wgsl', 'shell']
  .map(lang => lang + ' ' + report[lang].length).join(', '));
