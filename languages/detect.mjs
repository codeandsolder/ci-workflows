#!/usr/bin/env node
// Discover caller Git-tracked sources, never generated CI checkout files.
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

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
const java = files.filter(path => path.endsWith('.java'));
const rust = files.filter(path => path.endsWith('.rs'));
const report = { format: 1, java, rust, has_java: java.length > 0, has_rust: rust.length > 0 };
writeFileSync(resolve(manifestArgument), JSON.stringify(report) + '\n');
const lines = ['has_java=' + report.has_java, 'has_rust=' + report.has_rust,
  'java_count=' + java.length, 'rust_count=' + rust.length];
if (outputArgument) {
  writeFileSync(resolve(outputArgument), lines.join('\n') + '\n', { flag: 'a' });
}
console.log('Tracked sources: Java ' + java.length + ', Rust ' + rust.length);
