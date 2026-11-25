import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Temporary integration pin for the upstream contribution. This draft must
// switch to the reviewed upstream revision before production promotion.
export const nextestVersion = "0.9.152";

export const collector = {
  repository: 'https://github.com/codeandsolder/cargo-affected.git',
  revision: '182a1e7915f32dbca4fd93e20296f02c252ba91e',
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

function parseSuite(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('test-suite must be a JSON object');
  for (const key of Object.keys(config)) {
    if (!['name', 'directory', 'cargo', 'nextest', 'doctests', 'coverage'].includes(key)) throw new Error('Unknown test-suite key: ' + key);
  }
  const name = config.name;
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('test-suite name must be a filesystem-safe identifier');
  const directory = config.directory ?? '.';
  if (typeof directory !== 'string' || !directory || /[\r\n\0]/.test(directory) || isAbsolute(directory) || directory.split(/[\\/]/).includes('..')) {
    throw new Error('test-suite directory must be relative to the caller repository');
  }
  const coverage = config.coverage ?? true;
  if (typeof coverage !== 'boolean') throw new Error('test-suite coverage must be boolean');
  return {
    name,
    directory,
    cargo: argumentsArray(config.cargo ?? ['--workspace', '--locked'], 'cargo'),
    nextest: argumentsArray(config.nextest ?? [], 'nextest'),
    doctests: config.doctests == null ? null : argumentsArray(config.doctests, 'doctests'),
    coverage,
  };
}

export function parseSuites(source) {
  const configs = JSON.parse(source);
  if (!Array.isArray(configs) || configs.length === 0) throw new Error('test-suites must be a nonempty JSON array');
  const suites = configs.map(parseSuite);
  if (new Set(suites.map(suite => suite.name)).size !== suites.length) throw new Error('test-suite names must be unique');
  return suites;
}

export function collectArgs(suite, impactDir, stateDir) {
  return [
    'affected', 'collect', '--state-dir', stateDir,
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

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function prepare(suites) {
  const root = realpathSync(process.env.GITHUB_WORKSPACE);
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP, 'rust-test-suite-'));
  const impact = join(dir, 'impact');
  const coverage = join(dir, 'coverage');
  mkdirSync(impact);
  mkdirSync(coverage);
  const compiler = suites.map(suite => {
    const cwd = callerDirectory(suite);
    const manifest = checkedOutput('cargo', ['locate-project', '--workspace', '--message-format', 'plain'], cwd);
    if (realpathSync(dirname(manifest)) !== cwd) throw new Error('test-suite directory must be the Cargo workspace root');
    return { cwd, suite, version: checkedOutput('rustc', ['-vV'], cwd) };
  });
  const identity = [
    collector.repository, collector.revision, nextestVersion, process.platform, process.arch,
    process.env.RUSTFLAGS ?? '', process.env.CARGO_ENCODED_RUSTFLAGS ?? '', process.env.CARGO_BUILD_TARGET ?? '',
  ];
  // Keep cache transport separate from builds. An argument change invalidates
  // only that scope's database, even when other scopes share a job.
  const group = digest([identity, compiler.map(({ suite, cwd, version }) => [suite.name, relative(root, cwd), version]).sort()]);
  const target = process.env.CARGO_TARGET_DIR;
  if (!target || !isAbsolute(target)) throw new Error('Unified test suites require the provider runner-local Cargo target directory');
  const baselineDir = join(target, 'test-impact-baselines', group);
  const entries = compiler.map(({ suite, cwd, version }) => {
    const scope = digest([identity, version, relative(root, cwd), suite.name, suite.cargo, suite.nextest]);
    const stateDir = join(target, 'test-impact-state', group, scope);
    const impactDir = join(impact, suite.name);
    const coverageDir = join(coverage, suite.name);
    mkdirSync(impactDir);
    if (suite.coverage) mkdirSync(coverageDir);
    return {
      suite, cwd, stateDir, impactDir, coverageDir,
      baseline: join(baselineDir, scope + '.db'),
    };
  });
  mkdirSync(baselineDir, { recursive: true });
  const plan = join(dir, 'plan.json');
  writeFileSync(plan, JSON.stringify({ entries, baselineDir }));
  const outputs = {
    prefix: 'rust-test-impact-v3-' + group + '-',
    'baseline-dir': baselineDir,
    plan,
    'impact-dir': impact,
    'coverage-dir': coverage,
    'artifact-suffix': basename(dir).slice('rust-test-suite-'.length),
    coverage: String(suites.some(suite => suite.coverage)),
  };
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => key + '=' + value + '\n').join(''));
}

function installCollector() {
  const toolRoot = join(process.env.RUNNER_TEMP, 'cargo-affected-install');
  invoke(['install', '--locked', '--git', collector.repository, '--rev', collector.revision, '--root', toolRoot, 'cargo-affected']);
  appendFileSync(process.env.GITHUB_PATH, join(toolRoot, 'bin') + '\n');
}

function runFull(suite, cwd, impactDir, stateDir) {
  const log = join(impactDir, 'nextest.jsonl');
  const fd = openSync(log, 'w');
  try {
    invoke(collectArgs(suite, impactDir, stateDir), {
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

function runNode(file, args, env = process.env) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url)), ...args], {
    env, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(file + ' exited with status ' + result.status);
}

function logWarning(message) {
  process.stderr.write('warning: ' + message + '\n');
}

function summaryHeading(name) {
  const line = '\n# Rust test scope: ' + name + '\n\n';
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line);
  else process.stdout.write(line);
}

function execute(plan) {
  let failed = false;
  for (const { suite, cwd, stateDir, impactDir, coverageDir, baseline } of plan.entries) {
    summaryHeading(suite.name);
    process.stdout.write('Executing test scope: ' + suite.name + '\n');
    let full = false;
    try {
      mkdirSync(stateDir, { recursive: true });
      if (existsSync(baseline)) {
        try { copyFileSync(baseline, join(stateDir, 'coverage.db')); }
        catch (error) { logWarning(suite.name + ': baseline restore: ' + error.message); }
      }
      runFull(suite, cwd, impactDir, stateDir);
      full = true;
      try { copyFileSync(join(stateDir, 'coverage.db'), baseline); }
      catch (error) { logWarning(suite.name + ': baseline save: ' + error.message); }
    } catch (error) {
      process.stderr.write(suite.name + ': ' + error.message + '\n');
      failed = true;
    }
    try {
      runNode('./compare.mjs', [join(impactDir, 'selection.json'), join(impactDir, 'nextest.jsonl'), String(full), join(impactDir, 'comparison.json')]);
    } catch (error) {
      logWarning(suite.name + ': ' + error.message);
    }
    let coverageStatus = 'skipped';
    if (full && suite.coverage) {
      try {
        generateCoverage(cwd, impactDir, coverageDir);
        coverageStatus = 'success';
      } catch (error) {
        coverageStatus = 'failure';
        logWarning(suite.name + ': ' + error.message);
      }
    }
    if (suite.coverage) {
      writeFileSync(join(coverageDir, 'status.json'), JSON.stringify({ status: coverageStatus }));
    }
    // The instrumented executable is needed only until the reports have been
    // written. Keep DBs in the separate transport directory and release disk
    // before compiling the next distinct scope.
    rmSync(join(stateDir, 'build'), { recursive: true, force: true });
    rmSync(join(impactDir, 'aggregate.profdata'), { force: true });
    rmSync(join(impactDir, 'build.json'), { force: true });
    if (suite.doctests !== null) {
      try {
        invoke(['test', '--doc', ...suite.doctests], { cwd });
      } catch (error) {
        process.stderr.write(suite.name + ' doctests: ' + error.message + '\n');
        failed = true;
      }
    }
  }
  if (failed) throw new Error('One or more authoritative test scopes failed');
  // Do not accumulate obsolete argument hashes in the transported cache.
  const active = new Set(plan.entries.map(entry => basename(entry.baseline)));
  for (const file of readdirSync(plan.baselineDir)) {
    if (file.endsWith('.db') && !active.has(file)) rmSync(join(plan.baselineDir, file));
  }
}

function summarize(plan) {
  for (const { suite, coverageDir } of plan.entries) {
    if (!suite.coverage) continue;
    summaryHeading(suite.name);
    let status = 'skipped';
    try { status = JSON.parse(readFileSync(join(coverageDir, 'status.json'), 'utf8')).status; }
    catch (error) { logWarning(error.message); }
    runNode('../rust-coverage/summary.mjs', [], {
      ...process.env,
      COVERAGE_JSON: join(coverageDir, 'coverage.json'),
      COVERAGE_STATUS: status,
      COVERAGE_DIRECTORY: suite.directory + ' (' + suite.name + ')',
      COVERAGE_ARTIFACT_SUBDIR: suite.name,
    });
  }
}

function main() {
  const phase = process.argv[2];
  if (phase === 'install') return installCollector();
  if (phase === 'prepare') return prepare(parseSuites(process.env.TEST_SUITES));
  const plan = JSON.parse(readFileSync(process.env.TEST_SUITE_PLAN, 'utf8'));
  switch (phase) {
    case 'execute': return execute(plan);
    case 'summarize': return summarize(plan);
    default: throw new Error('Unknown test-suite phase: ' + phase);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
