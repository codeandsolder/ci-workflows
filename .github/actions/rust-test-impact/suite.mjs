import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Temporary integration pin for the upstream contribution. This draft must
// switch to the reviewed upstream revision before production promotion.
export const nextestVersion = "0.9.152";

export const collector = {
  repository: 'https://github.com/codeandsolder/cargo-affected.git',
  revision: 'cf6b3811944c0b1aac24d62e75203e97300db8bd',
};

const reserved = new Set([
  '--manifest-path', '--target-dir', '--build-dir',
  '--no-run', '--message-format', '--message-format-version',
  '--no-tests', '--fail-fast', '--no-fail-fast', '--max-fail', '--rerun',
]);

function argumentsArray(value, name) {
  if (!Array.isArray(value) || value.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length === 0)) {
    throw new Error(name + ' must be an array of non-empty argument strings');
  }
  for (const arg of value) {
    const flag = arg.split('=', 1)[0];
    if (reserved.has(flag)) throw new Error(name + ' must not override ' + flag);
  }
  return value;
}

export function parseSuite(source) {
  const config = JSON.parse(source);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('test-suite must be a JSON object');
  for (const key of Object.keys(config)) {
    if (!['directory', 'cargo', 'nextest', 'doctests', 'coverage'].includes(key)) throw new Error('Unknown test-suite key: ' + key);
  }
  const directory = config.directory ?? '.';
  if (typeof directory !== 'string' || !directory || /[\r\n\0]/.test(directory) || isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) {
    throw new Error('test-suite directory must be relative to the caller repository');
  }
  const coverage = config.coverage ?? true;
  if (typeof coverage !== 'boolean') throw new Error('test-suite coverage must be boolean');
  return {
    directory,
    cargo: argumentsArray(config.cargo ?? ['--workspace', '--locked'], 'cargo'),
    nextest: argumentsArray(config.nextest ?? [], 'nextest'),
    doctests: config.doctests == null ? null : argumentsArray(config.doctests, 'doctests'),
    coverage,
  };
}

export function collectArgs(suite, impactDir) {
  return [
    'affected', 'collect',
    '--report-json', join(impactDir, 'selection.json'), '--report-detail', 'full',
    ...(suite.coverage ? [
      '--aggregate-profile', join(impactDir, 'aggregate.profdata'),
      '--build-info-json', join(impactDir, 'build.json'),
    ] : []),
    '--', '--no-fail-fast', '--message-format', 'libtest-json-plus',
    ...suite.cargo, ...suite.nextest,
  ];
}

// Derive the reporting profile and target from Nextest's actual build
// metadata, rather than reinterpreting its Cargo/Nextest argument grammar.
export function reportArgs(buildMeta) {
  const dirs = buildMeta?.['base-output-directories'];
  if (!Array.isArray(dirs) || !dirs.length || dirs.some(dir => typeof dir !== 'string' || isAbsolute(dir))) {
    throw new Error('Nextest build metadata has no relative output directories');
  }
  const profiles = new Set();
  const targets = new Set();
  for (const dir of dirs) {
    const parts = dir.split(/[\\/]/);
    if (parts.length > 2 || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Unexpected Nextest output directory: ' + dir);
    profiles.add(parts.at(-1));
    if (parts.length === 2) targets.add(parts[0]);
  }
  if (profiles.size !== 1 || targets.size > 1) throw new Error('Multiple incompatible build layouts in one Nextest run');
  const [profile] = profiles;
  const [target] = targets;
  return [
    'llvm-cov', 'report', '--workspace', '--locked',
    ...(profile === 'debug' ? [] : profile === 'release' ? ['--release'] : ['--profile', profile]),
    ...(target ? ['--target', target] : []),
  ];
}

function invoke(args, options = {}) {
  const result = spawnSync('cargo', args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.signal) throw new Error('Cargo was terminated by ' + result.signal);
  if (result.status !== 0) throw new Error('Cargo exited with status ' + result.status + ': ' + args.slice(0, 2).join(' '));
}

function checkedOutput(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + ' failed: ' + result.status);
  return result.stdout.trim();
}

function callerDirectory(suite) {
  const root = realpathSync(process.env.GITHUB_WORKSPACE);
  const cwd = realpathSync(resolve(root, suite.directory));
  const rel = relative(root, cwd);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('test-suite escapes the caller repository');
  return cwd;
}

function prepare(suite, cwd) {
  const manifest = checkedOutput('cargo', ['locate-project', '--workspace', '--message-format', 'plain'], cwd);
  if (realpathSync(dirname(manifest)) !== cwd) throw new Error('test-suite directory must be the Cargo workspace root');
  const version = checkedOutput('rustc', ['-vV'], cwd);
  const scope = JSON.stringify([
    collector.repository, collector.revision, nextestVersion, process.platform, process.arch, version,
    relative(realpathSync(process.env.GITHUB_WORKSPACE), cwd), suite.cargo, suite.nextest,
    process.env.RUSTFLAGS ?? '', process.env.CARGO_BUILD_TARGET ?? '',
  ]);
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, 24);
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP, 'rust-test-suite-'));
  const impact = join(dir, 'impact');
  const coverage = join(dir, 'coverage');
  mkdirSync(impact);
  mkdirSync(coverage);
  const outputs = {
    prefix: 'rust-test-impact-v2-' + digest + '-',
    'db-path': join(cwd, 'target', 'affected', 'coverage.db'),
    'impact-dir': impact,
    'coverage-dir': coverage,
    'artifact-suffix': basename(dir).slice('rust-test-suite-'.length),
    coverage: String(suite.coverage),
    doctests: String(suite.doctests !== null),
    directory: suite.directory,
  };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => key + '=' + value + '\n').join(''));
}

function installCollector() {
  const toolRoot = join(process.env.RUNNER_TEMP, 'cargo-affected-install');
  invoke(['install', '--locked', '--git', collector.repository, '--rev', collector.revision, '--root', toolRoot, 'cargo-affected']);
  appendFileSync(process.env.GITHUB_PATH, join(toolRoot, 'bin') + '\n');
}

function runFull(suite, cwd, impactDir) {
  const log = join(impactDir, 'nextest.jsonl');
  const fd = openSync(log, 'w');
  try {
    invoke(collectArgs(suite, impactDir), {
      cwd,
      env: { ...process.env, NEXTEST_EXPERIMENTAL_LIBTEST_JSON: '1' },
      stdio: ['inherit', fd, 'inherit'],
    });
  } catch (error) {
    // Nextest's machine-readable results include failed test output. Surface
    // the failing identities in CI logs as well as keeping the raw artifact.
    for (const line of readFileSync(log, 'utf8').split(/\r?\n/)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'test' && ['failed', 'timeout', 'exec-fail'].includes(event.event)) {
        process.stderr.write(JSON.stringify(event) + '\n');
      }
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

function generateCoverage(cwd, impactDir, coverageDir) {
  const info = JSON.parse(readFileSync(join(impactDir, 'build.json'), 'utf8'));
  if (realpathSync(info['workspace-root']) !== cwd) throw new Error('Coverage build belongs to a different workspace');
  const meta = info['rust-build-meta'];
  const target = meta['target-directory'];
  const build = meta['build-directory'] ?? target;
  if (!isAbsolute(target) || !isAbsolute(build)) throw new Error('Nextest returned non-absolute build paths');
  // cargo-llvm-cov report reuses an indexed profile if there are no raw
  // profiles to merge. The collector already consumed all those counters;
  // refuse to overwrite it with a partial raw-profile merge.
  if (readdirSync(target).some(name => name.endsWith('.profraw'))) throw new Error('Unmerged profiles would overwrite the aggregate');
  const profile = join(target, basename(cwd) + '.profdata');
  copyFileSync(join(impactDir, 'aggregate.profdata'), profile);
  const options = {
    cwd,
    env: { ...process.env, CARGO_LLVM_COV_TARGET_DIR: target, CARGO_LLVM_COV_BUILD_DIR: build },
  };
  // Managed sccache remaps dependency sources to /build; they are not
  // workspace sources and must not inflate totals or generate broken HTML.
  const args = [...reportArgs(meta), '--ignore-filename-regex', '^/build/'];
  invoke([...args, '--html', '--output-dir', coverageDir], options);
  invoke([...args, '--lcov', '--output-path', join(coverageDir, 'lcov.info')], options);
  invoke([...args, '--json', '--output-path', join(coverageDir, 'coverage.json')], options);
}

function main() {
  const phase = process.argv[2];
  if (phase === 'install') return installCollector();
  const suite = parseSuite(process.env.TEST_SUITE);
  const cwd = callerDirectory(suite);
  const impactDir = process.env.IMPACT_DIR;
  switch (phase) {
    case 'prepare': return prepare(suite, cwd);
    case 'collect': return runFull(suite, cwd, impactDir);
    case 'report': return generateCoverage(cwd, impactDir, process.env.COVERAGE_DIR);
    case 'doctests': return invoke(['test', '--doc', ...suite.doctests], { cwd });
    default: throw new Error('Unknown test-suite phase: ' + phase);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
