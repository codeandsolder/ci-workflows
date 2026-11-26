import { spawnSync } from 'node:child_process';
import { appendFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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

export function runStrictScopes(scopes, root, toolchain, spawn = spawnSync) {
  const gate = join(root, '.rust-skills2-gate');
  const script = join(gate, 'scripts', 'strict_clippy.sh');
  const action = join(gate, '.github', 'actions', 'rust-strict');
  const failures = [];
  for (const scope of scopes) {
    console.log('Strict Rust scope: ' + scope.name);
    const result = spawn('bash', [script, '--toolchain', toolchain], {
      cwd: root, stdio: 'inherit',
      env: {
        ...process.env, GITHUB_WORKSPACE: root,
        RUST_SKILLS2_ACTION_DIR: action,
        RUST_SKILLS2_WORKING_DIRECTORY: scope.directory,
        RUST_SKILLS2_CARGO_ARGS: scope.cargo.join(' '),
        RUST_SKILLS2_ALLOW_TEST_PANICS: String(scope.panics),
      },
    });
    if (result.error || result.status !== 0) {
      failures.push(scope.name + ': ' + (result.error?.message ?? result.signal ?? result.status));
      // Retain the old strict job's per-workspace diagnostic after a failure.
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
    case 'prepare': {
      const directories = dependencyDirectories(scopes);
      appendFileSync(process.env.GITHUB_OUTPUT, 'dependency-directories=' + JSON.stringify(directories) + '\n');
      break;
    }
    case 'execute':
      runStrictScopes(scopes, root, process.env.STRICT_TOOLCHAIN);
      break;
    default: throw new Error('usage: run.mjs prepare|execute');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
