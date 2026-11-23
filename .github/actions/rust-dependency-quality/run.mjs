import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function summarize(audit, unused, flags = {}) {
  const lines = [
    '## Rust dependency health (informational)',
    '',
    'No additional compilation, no minimum threshold, and no change to required Rust checks.',
    '',
    '| Check | Findings | Status |',
    '| --- | ---: | --- |',
    `| RustSec / cargo-deny | ${audit.findings.length} | ${audit.failed || flags.auditUnavailable ? 'Unavailable' : audit.findings.length ? 'Review advisories' : 'No findings'} |`,
    `| Unused direct dependencies / cargo-machete | ${unused.findings.length} | ${unused.failed || flags.unusedUnavailable ? 'Unavailable' : unused.findings.length ? 'Review candidates' : 'No candidates'} |`,
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
  if (audit.failed || unused.failed || flags.auditUnavailable || flags.unusedUnavailable) {
    lines.push('One or more scanners did not complete. Inspect the attached raw diagnostics; an unavailable scan is not a clean audit.', '');
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

function main() {
  const workdir = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), process.env.DEPENDENCY_WORKDIR ?? '.');
  const reportDir = resolve(process.env.RUNNER_TEMP ?? process.cwd(), 'rust-dependency-quality');
  mkdirSync(reportDir, { recursive: true });
  const config = resolve(dirname(fileURLToPath(import.meta.url)), 'deny.toml');
  const installed = process.env.DEPENDENCY_SCANNERS_INSTALLED === 'success';
  const present = existsSync(resolve(workdir, 'Cargo.toml'));
  const auditRun = installed && present
    ? run('cargo-deny', ['-f', 'json', '--config', config, '--manifest-path', resolve(workdir, 'Cargo.toml'), '--workspace', 'check', 'advisories'], { cwd: workdir })
    : null;
  const macheteRun = installed && present
    ? run('cargo-machete', ['--with-metadata', '--json', '--skip-target-dir', '--skip-patterns', '.ci-workflows', '.rust-skills2-gate', 'node_modules', '.git'], { cwd: workdir, timeout: 120_000 })
    : null;

  const audit = auditRun
    ? parseAdvisoryOutput(auditRun.output, auditRun.status)
    : { diagnostics: [], errors: [], findings: [], failed: true };
  const unused = macheteRun
    ? parseMacheteOutput(macheteRun.stdout, macheteRun.status)
    : { findings: [], failed: true };

  if (auditRun?.error) audit.errors.push(auditRun.error);
  if (macheteRun?.error) unused.failed = true;
  writeFileSync(resolve(reportDir, 'audit.jsonl'), auditRun?.output ?? 'Scanner unavailable\n');
  writeFileSync(resolve(reportDir, 'unused.json'), macheteRun?.stdout ?? '{}');
  writeFileSync(resolve(reportDir, 'results.json'), JSON.stringify({
    audit, unused, installed, present,
    auditExitCode: auditRun?.status ?? null,
    unusedExitCode: macheteRun?.status ?? null,
    auditError: auditRun?.error ?? null,
    unusedError: macheteRun?.error ?? null,
    unusedStderr: macheteRun?.stderr ?? null,
  }, null, 2) + '\n');

  const text = !present
    ? '## Rust dependency health\n\nSkipped: selected directory does not contain Cargo.toml.\n'
    : summarize(audit, unused, { auditUnavailable: !installed, unusedUnavailable: !installed });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  else process.stdout.write(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
