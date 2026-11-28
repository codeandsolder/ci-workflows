import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultCargo = ['--locked', '--workspace', '--all-targets'];

export function parseStrictSuites(source, root) {
  const raw = JSON.parse(source);
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('strict-suites must be a nonempty JSON array');
  const canonicalRoot = realpathSync(root);
  const names = new Set();
  return raw.map(scope => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('strict scope must be an object');
    for (const key of Object.keys(scope)) {
      if (!['name', 'directory', 'cargo', 'allow-test-panics', 'dependency-quality'].includes(key)) {
        throw new Error('Unknown strict scope key: ' + key);
      }
    }
    const {name, directory = '.', cargo = defaultCargo} = scope;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name) || names.has(name)) {
      throw new Error('Strict scope names must be unique filesystem-safe identifiers');
    }
    names.add(name);
    if (typeof directory !== 'string' || !directory || isAbsolute(directory) ||
        /[\r\n\0\\]/.test(directory) || directory.split('/').includes('..')) {
      throw new Error('Strict scope directory must be repository-relative');
    }
    const cwd = realpathSync(resolve(canonicalRoot, directory));
    const rel = relative(canonicalRoot, cwd);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Strict scope escapes the caller checkout');
    if (!statSync(join(cwd, 'Cargo.toml')).isFile()) throw new Error('Strict scope needs Cargo.toml: ' + directory);
    // The policy script is the authority on allowed Cargo selectors. Its
    // existing input is a whitespace-delimited list, so never flatten a
    // token that would change meaning when the policy reads it.
    if (!Array.isArray(cargo) || !cargo.length || cargo.some(arg => typeof arg !== 'string' || !arg || /[\s\0]/.test(arg))) {
      throw new Error('Strict scope Cargo selectors must be nonempty single-token strings');
    }
    const panics = scope['allow-test-panics'] ?? false;
    const dependencyQuality = scope['dependency-quality'] ?? true;
    if (typeof panics !== 'boolean' || typeof dependencyQuality !== 'boolean') throw new Error('Strict scope policy switches must be booleans');
    return {name, directory: rel || '.', cargo, panics, dependencyQuality};
  });
}

export function dependencyDirectories(scopes) {
  return [...new Set(scopes.filter(scope => scope.dependencyQuality).map(scope => scope.directory))];
}

function scopeEnvironment(scope, root) {
  return {
    ...process.env, GITHUB_WORKSPACE: root,
    RUST_SKILLS2_ACTION_DIR: join(root, '.rust-skills2-gate', '.github', 'actions', 'rust-strict'),
    RUST_SKILLS2_WORKING_DIRECTORY: scope.directory,
    RUST_SKILLS2_CARGO_ARGS: scope.cargo.join(' '),
    RUST_SKILLS2_ALLOW_TEST_PANICS: String(scope.panics),
  };
}

function runPhase(scope, root, toolchain, phase, plan, spawn) {
  const script = join(root, '.rust-skills2-gate', 'scripts', 'strict_clippy.sh');
  const args = [script, '--toolchain', toolchain, '--phase', phase];
  if (plan) args.push('--plan', plan);
  console.log('Strict Rust ' + phase + ': ' + scope.name);
  return spawn('bash', args, {
    cwd: root, stdio: 'inherit', env: scopeEnvironment(scope, root),
  });
}

function failure(result) {
  return result.error?.message ?? (result.status === 0 ? null : result.signal ?? result.status ?? 'unknown failure');
}

function workspaceDirectory(scope, root, toolchain, spawn) {
  const result = spawn('cargo', ['+' + toolchain, 'locate-project', '--workspace', '--message-format', 'plain'], {
    cwd: resolve(root, scope.directory), encoding: 'utf8',
  });
  const problem = failure(result);
  if (problem !== null) throw new Error(scope.name + ': cargo locate-project: ' + problem + '\n' + (result.stderr ?? ''));
  const directory = dirname(realpathSync(result.stdout.trim()));
  const rel = relative(root, directory);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Cargo workspace escapes the caller checkout: ' + scope.name);
  return rel || '.';
}

export function resolveScopeWorkspaces(scopes, root, toolchain, spawn = spawnSync) {
  const resolved = new Map();
  return scopes.map(scope => {
    if (!resolved.has(scope.directory)) {
      resolved.set(scope.directory, workspaceDirectory(scope, root, toolchain, spawn));
    }
    return {scope, directory: resolved.get(scope.directory)};
  });
}

export function preflightScopes(scopes, root, toolchain, planDir, spawn = spawnSync) {
  const workspaces = resolveScopeWorkspaces(scopes, root, toolchain, spawn);
  const formatted = new Set();
  for (const {scope, directory} of workspaces) {
    if (formatted.has(directory)) continue;
    const problem = failure(runPhase({...scope, directory}, root, toolchain, 'format', null, spawn));
    if (problem !== null) throw new Error('Rust formatting failed: ' + directory + ': ' + problem);
    formatted.add(directory);
  }
  for (const scope of scopes) {
    const problem = failure(runPhase(scope, root, toolchain, 'preflight', join(planDir, scope.name), spawn));
    if (problem !== null) throw new Error('Rust preflight failed: ' + scope.name + ': ' + problem);
  }
  return dependencyDirectories(workspaces.map(({scope, directory}) => ({...scope, directory})));
}

export function runStrictScopes(scopes, root, toolchain, planDir, spawn = spawnSync) {
  const failures = [];
  // One shared Cargo target: concurrent independent Cargo invocations would
  // contend on the target lock and can destroy fingerprint reuse.
  for (const scope of scopes) {
    const result = runPhase(scope, root, toolchain, 'compile', join(planDir, scope.name), spawn);
    const problem = failure(result);
    if (problem !== null) {
      failures.push(scope.name + ': ' + problem);
      spawn('cargo', ['+' + toolchain, 'report', 'future-incompatibilities'], {
        cwd: resolve(root, scope.directory), stdio: 'inherit',
      });
    }
  }
  if (failures.length) throw new Error('Strict Rust scopes failed: ' + failures.join('; '));
}

function main() {
  const root = realpathSync(process.env.GITHUB_WORKSPACE);
  const scopes = parseStrictSuites(process.env.STRICT_SUITES, root);
  switch (process.argv[2]) {
    case 'prepare':
      break; // Validate scope declarations before toolchain/cache setup.
    case 'dependency-directories': {
      const workspaces = resolveScopeWorkspaces(scopes, root, process.env.STRICT_TOOLCHAIN);
      const directories = dependencyDirectories(workspaces.map(({scope, directory}) => ({...scope, directory})));
      appendFileSync(process.env.GITHUB_OUTPUT, 'directories=' + JSON.stringify(directories) + '\n');
      break;
    }
    case 'preflight': {
      const planDir = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'strict-plan-'));
      try {
        preflightScopes(scopes, root, process.env.STRICT_TOOLCHAIN, planDir);
        appendFileSync(process.env.GITHUB_OUTPUT, 'plan-dir=' + planDir + '\n');
      } catch (error) {
        rmSync(planDir, {recursive:true, force:true});
        throw error;
      }
      break;
    }
    case 'compile': {
      const planDir = realpathSync(process.env.STRICT_PLAN_DIR);
      const runnerTemp = realpathSync(process.env.RUNNER_TEMP);
      if (dirname(planDir) !== runnerTemp || !relative(runnerTemp, planDir).startsWith('strict-plan-')) {
        throw new Error('Invalid runner-local strict plan directory');
      }
      try {
        runStrictScopes(scopes, root, process.env.STRICT_TOOLCHAIN, planDir);
      } finally {
        rmSync(planDir, {recursive:true, force:true});
      }
      break;
    }
    default: throw new Error('usage: run.mjs prepare|preflight|compile');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
