import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_WORKSPACE_SCAN_MS, scanWorkspaces, workspaceDirectories } from './run.mjs';

const script = fileURLToPath(import.meta.url);
const prefix = 'rust-dependency-scan-';

function stateDirectory(path) {
  const directory = realpathSync(path);
  const temp = realpathSync(process.env.RUNNER_TEMP);
  if (dirname(directory) !== temp || !basename(directory).startsWith(prefix)) {
    throw new Error('Invalid runner-local dependency scan state');
  }
  return directory;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function statusPath(directory) {
  return join(directory, 'status.json');
}

function workerStatus(directory) {
  return existsSync(statusPath(directory)) ? readJson(statusPath(directory)) : null;
}

function ownedWorker(pid, directory) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    const args = readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0');
    // Do not signal a recycled PID or a process from another runner job.
    return args[1] === script && args[2] === 'worker' && args[3] === directory;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw error;
  }
}

async function stopWorker(pid, directory) {
  for (const signal of ['SIGTERM','SIGKILL']) {
    if (!ownedWorker(pid, directory)) return;
    try {
      process.kill(-pid, signal); // detached worker and its scanner subprocesses
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      if (!ownedWorker(pid, directory)) return;
      await delay(50);
    }
  }
}

export async function launch() {
  if (process.platform !== 'linux') throw new Error('Overlapped dependency scanning requires Linux');
  const root = realpathSync(process.env.GITHUB_WORKSPACE);
  const directories = workspaceDirectories(process.env.DEPENDENCY_DIRECTORIES, root);
  const directory = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), prefix));
  const log = openSync(join(directory, 'worker.log'), 'wx', 0o600);
  let child;
  try {
    writeFileSync(join(directory, 'selection.json'), JSON.stringify({root, directories}));
    child = spawn(process.execPath, [script, 'worker', directory], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    await once(child, 'spawn');
    writeFileSync(join(directory, 'worker.json'), JSON.stringify({
      pid: child.pid,
      // Allow the existing per-tool timeout for every workspace, plus
      // bookkeeping overhead. No new unbounded wait on an advisory result.
      deadline: Date.now() + directories.length * (MAX_WORKSPACE_SCAN_MS + 10_000) + 10_000,
    }));
    appendFileSync(process.env.GITHUB_OUTPUT, 'scan-state=' + directory + '\n');
    child.unref();
    return directory;
  } catch (error) {
    if (child?.pid) await stopWorker(child.pid, directory);
    rmSync(directory, {recursive: true, force: true});
    throw error;
  } finally {
    closeSync(log);
  }
}

function worker(directory) {
  const {root, directories} = readJson(join(directory, 'selection.json'));
  let status = {status: 'success'};
  try {
    scanWorkspaces(root, directories, join(directory, 'report'), join(directory, 'summary.md'));
  } catch (error) {
    status = {status: 'unavailable', reason: String(error.message)};
    console.error(error);
    process.exitCode = 1;
  }
  const temporary = join(directory, 'status.tmp');
  writeFileSync(temporary, JSON.stringify(status));
  renameSync(temporary, statusPath(directory));
}

export async function collect(path, publish) {
  const directory = stateDirectory(path);
  const {pid, deadline} = readJson(join(directory, 'worker.json'));
  if (!publish) {
    await stopWorker(pid, directory);
    rmSync(directory, {recursive: true, force: true});
    return;
  }

  let status = workerStatus(directory);
  while (status === null && ownedWorker(pid, directory) && Date.now() < deadline) {
    await delay(100);
    status = workerStatus(directory);
  }
  // The worker can write the atomic completion marker just before exiting.
  status ??= workerStatus(directory);
  if (status === null) {
    await stopWorker(pid, directory);
    status = {status:'unavailable', reason:'Dependency scanner exited without a result or exceeded its existing tool time budget'};
  }

  const report = join(directory, 'report');
  mkdirSync(report, {recursive:true});
  writeFileSync(join(report, 'run-status.json'), JSON.stringify(status, null, 2) + '\n');
  const log = join(directory, 'worker.log');
  if (existsSync(log)) process.stdout.write(readFileSync(log, 'utf8'));
  const summary = join(directory, 'summary.md');
  if (process.env.GITHUB_STEP_SUMMARY) {
    if (existsSync(summary)) appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(summary));
    if (status.status !== 'success') {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\nDependency reporting unavailable or incomplete: ' + status.reason + '\n');
    }
  }
  if (status.status !== 'success') console.warn('Dependency reporting unavailable or incomplete: ' + status.reason);
  appendFileSync(process.env.GITHUB_OUTPUT, 'report-root=' + report + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const [mode, directory, publish] = process.argv.slice(2);
  if (mode === 'start') await launch();
  else if (mode === 'worker') worker(stateDirectory(directory));
  else if (mode === 'finish' && ['true','false'].includes(publish)) await collect(directory, publish === 'true');
  else throw new Error('usage: overlap.mjs start | worker STATE | finish STATE true|false');
}
