import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anointGateFailure, parseAnointOutput, summarizeAnoint } from './anoint.mjs';

export function parseAdvisoryOutput(raw, status) {
  const diagnostics = [];
  const errors = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.type === 'diagnostic') {
        const fields = record.fields ?? {};
        diagnostics.push({
          severity: fields.severity ?? 'unknown',
          code: fields.code ?? '?',
          message: fields.message ?? '',
        });
      } else if (record.type === 'log' && record.fields?.level === 'ERROR') {
        errors.push(record.fields.message ?? 'Unspecified cargo-deny error');
      }
    } catch {
      errors.push('Unparseable cargo-deny output: ' + line.slice(0, 180));
    }
  }
  const findings = diagnostics.filter((d) => d.severity === 'error' || d.severity === 'warning');
  const failed = status !== 0 && !findings.some((d) => d.severity === 'error');
  return { diagnostics, errors, findings, failed };
}

export function parseMacheteOutput(raw, status) {
  if (status !== 0 && status !== 1) {
    return { findings: [], failed: true };
  }
  try {
    const result = JSON.parse(raw);
    const entries = result.crates ?? [];
    if (!Array.isArray(entries)) throw new Error('Invalid crates array');
    const findings = entries.flatMap((entry) => {
      if (!Array.isArray(entry.unused)) throw new Error('Invalid unused field');
      return entry.unused.map((dependency) => ({
        package: entry.package_name,
        dependency,
        manifest: entry.manifest_path,
      }));
    });
    if ((status === 1) !== (findings.length > 0)) {
      throw new Error('cargo-machete exit status does not match findings');
    }
    return { findings, failed: false };
  } catch {
    return { findings: [], failed: true };
  }
}

export function summarize(audit, unused, anoint) {
  const anointSummary = summarizeAnoint(anoint);
  const lines = [
    '## Rust dependency health',
    '',
    'No additional compilation. Cargo-anoint is required; RustSec and unused-dependency reports remain advisory.',
    '',
    '| Check | Findings | Status |',
    '| --- | ---: | --- |',
    `| RustSec / cargo-deny | ${audit.findings.length} | ${audit.failed ? 'Unavailable' : audit.findings.length ? 'Review advisories' : 'No findings'} |`,
    `| Unused direct dependencies / cargo-machete | ${unused.findings.length} | ${unused.failed ? 'Unavailable' : unused.findings.length ? 'Review candidates' : 'No candidates'} |`,
    anointSummary.row,
    '',
  ];
  if (audit.findings.length) {
    lines.push('**Advisories and warnings**', '');
    for (const finding of audit.findings.slice(0, 30)) {
      lines.push(`- \`${finding.code}\` (${finding.severity}): ${finding.message.replaceAll('\n', ' ')}`);
    }
    if (audit.findings.length > 30) lines.push(`- …and ${audit.findings.length - 30} more in the artifact`);
    lines.push('');
  }
  if (unused.findings.length) {
    lines.push('**Potentially unused dependencies** (heuristic; inspect build scripts, generated code, feature combinations, and FFI before removal)', '');
    for (const finding of unused.findings.slice(0, 40)) {
      lines.push(`- \`${finding.package}\`: \`${finding.dependency}\``);
    }
    if (unused.findings.length > 40) lines.push(`- …and ${unused.findings.length - 40} more in the artifact`);
    lines.push('');
  }
  lines.push(...anointSummary.lines);
  if (audit.failed || unused.failed || anoint.failed) {
    lines.push('One or more scanners did not complete. Inspect the raw diagnostics (public artifact or private job log); an unavailable scan is not a clean audit.', '');
  }
  lines.push('Advisory reporting is not a vulnerability acceptance or release-age policy. The existing 72-hour crates.io gate remains independent.', '');
  return lines.join('\n') + '\n';
}

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, {
    cwd: options.cwd,
    timeout: options.timeout ?? 120_000,
    encoding: 'utf8',
    maxBuffer: 24 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: (result.stdout ?? '') + '\n' + (result.stderr ?? ''),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
}

export function workspaceDirectories(source, root) {
  const directories = JSON.parse(source);
  if (!Array.isArray(directories) || !directories.length) throw new Error('working-directories must be a nonempty JSON array');
  const canonicalRoot = realpathSync(root);
  return [...new Set(directories.map(directory => {
    if (typeof directory !== 'string' || !directory || isAbsolute(directory) ||
        /[\r\n\0\\]/.test(directory) || directory.split('/').includes('..')) {
      throw new Error('Dependency scan directory must be repository-relative');
    }
    const cwd = realpathSync(resolve(canonicalRoot, directory));
    const rel = relative(canonicalRoot, cwd);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
      throw new Error('Dependency scan escapes the caller checkout');
    }
    return rel || '.';
  }))];
}

function scanWorkspace(root, directory, reportDir, summaryPath) {
  const workdir = resolve(root, directory);
  mkdirSync(reportDir, { recursive: true });
  const config = resolve(dirname(fileURLToPath(import.meta.url)), 'deny.toml');
  const installed = process.env.DEPENDENCY_SCANNERS_INSTALLED === 'success';
  const present = existsSync(resolve(workdir, 'Cargo.toml'));
  const auditRun = installed && present
    ? run('cargo-deny', ['-f', 'json', '--config', config, '--manifest-path', resolve(workdir, 'Cargo.toml'), '--workspace', 'check', 'advisories'], { cwd: workdir })
    : null;
  const ignoredDirs = ['.ci-workflows', '.rust-skills2-gate', 'node_modules', '.git']
    .filter((name) => existsSync(resolve(workdir, name)));
  const macheteArgs = ['--with-metadata', '--json', '--skip-target-dir'];
  for (const directory of ignoredDirs) macheteArgs.push('--skip-patterns', directory);
  const macheteRun = installed && present
    ? run('cargo-machete', macheteArgs, { cwd: workdir, timeout: 120_000 })
    : null;

  const anointBinary = process.env.DEPENDENCY_ANOINT_BINARY;
  const anointRun = anointBinary && present
    ? run(anointBinary, ['anoint', '--workspace', '--offline', '--json', '--all-features', '--all-targets', '--fail-on-overlap'], { cwd: workdir, timeout: 180_000 })
    : null;
  const anoint = parseAnointOutput(anointRun?.stdout ?? '', anointRun?.status ?? null, anointRun?.stderr);

  const audit = auditRun
    ? parseAdvisoryOutput(auditRun.output, auditRun.status)
    : { diagnostics: [], errors: [], findings: [], failed: true };
  const unused = macheteRun
    ? parseMacheteOutput(macheteRun.stdout, macheteRun.status)
    : { findings: [], failed: true };

  if (auditRun?.error) audit.errors.push(auditRun.error);
  if (macheteRun?.error) unused.failed = true;
  if (anointRun?.error) anoint.failed = true;
  writeFileSync(resolve(reportDir, 'audit.jsonl'), auditRun?.output ?? 'Scanner unavailable\n');
  writeFileSync(resolve(reportDir, 'unused.json'), macheteRun?.stdout ?? '{}');
  writeFileSync(resolve(reportDir, 'anoint.json'), anointRun?.stdout ?? '{}');
  writeFileSync(resolve(reportDir, 'results.json'), JSON.stringify({
    directory, audit, unused, anoint, installed, present,
    anointInstalled: Boolean(anointBinary),
    anointExitCode: anointRun?.status ?? null,
    anointError: anointRun?.error ?? null,
    anointStderr: anointRun?.stderr ?? null,
    auditExitCode: auditRun?.status ?? null,
    unusedExitCode: macheteRun?.status ?? null,
    auditError: auditRun?.error ?? null,
    unusedError: macheteRun?.error ?? null,
    unusedStderr: macheteRun?.stderr ?? null,
  }, null, 2) + '\n');

  const text = 'Workspace: `' + directory.replaceAll('`', '&#96;') + '`\n\n' + (!present
    ? '## Rust dependency health\n\nGate failed: selected directory does not contain Cargo.toml.\n'
    : summarize(audit, unused, anoint));
  if (summaryPath) appendFileSync(summaryPath, text);
  else process.stdout.write(text);
  const failure = anointGateFailure(anoint);
  if (failure) throw new Error(failure);
}

// Individual tool subprocesses are bounded at 120 + 120 + 180 seconds.
export const MAX_WORKSPACE_SCAN_MS = 420_000;

export function scanWorkspaces(root, directories, reportRoot, summaryPath) {
  mkdirSync(reportRoot, {recursive:true});
  const entries = directories.map((directory, index) => ({directory, report: 'workspace-' + index}));
  writeFileSync(resolve(reportRoot, 'index.json'), JSON.stringify(entries, null, 2) + '\n');
  const failures = [];
  for (const {directory, report} of entries) {
    try { scanWorkspace(root, directory, resolve(reportRoot, report), summaryPath); }
    catch (error) { failures.push(directory + ': ' + error.message); }
  }
  if (failures.length) throw new Error('Dependency gate failed: ' + failures.join('; '));
}

function main() {
  const root = realpathSync(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const directories = workspaceDirectories(process.env.DEPENDENCY_DIRECTORIES, root);
  if (process.argv[2] === 'validate') return;
  const reportRoot = resolve(process.env.RUNNER_TEMP ?? process.cwd(), 'rust-dependency-quality');
  scanWorkspaces(root, directories, reportRoot, process.env.GITHUB_STEP_SUMMARY);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
