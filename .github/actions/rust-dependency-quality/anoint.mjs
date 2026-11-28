const kinds = new Set(['ModernAlternative', 'FeatureOptimization', 'StdReplacement', 'ComboWin', 'CapabilityOverlap', 'AdvisoryOverlap', 'Unmaintained']);
const impacts = new Set(['High', 'Medium', 'Low']);

function validateSuggestion(suggestion) {
  if (!suggestion || !kinds.has(suggestion.kind) || !impacts.has(suggestion.impact) ||
      ['current', 'recommended', 'reason'].some((key) => typeof suggestion[key] !== 'string')) {
    throw new Error('Invalid dependency suggestion');
  }
}

export function parseAnointOutput(raw, status, stderr = '') {
  const failed = { findings: [], packages: 0, version: null, policyTriggered: false, failed: true };
  // The CLI writes its complete report before returning the caller policy's
  // intentional nonzero exit. Never mistake a metadata failure for findings.
  const policyTriggered = status === 1 && /(?:^|\n)Error: exiting with non-zero status: (?:potential overlapping dependency providers|at least one dependency suggestion matched --fail-on)\s*$/.test(stderr);
  if (status !== 0 && !policyTriggered) return failed;
  try {
    const report = JSON.parse(raw);
    if (typeof report.cargo_anoint_version !== 'string' || report.workspace_scan !== true ||
        !Array.isArray(report.packages) || report.packages.length === 0) throw new Error('Invalid workspace report');
    const findings = report.packages.flatMap((pkg) => {
      if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' ||
          typeof pkg.manifest_path !== 'string' || !Array.isArray(pkg.dependency_suggestions)) {
        throw new Error('Invalid package report');
      }
      return pkg.dependency_suggestions.map((suggestion) => {
        validateSuggestion(suggestion);
        return { ...suggestion, scope: 'package', package: pkg.name, packageVersion: pkg.version, manifest: pkg.manifest_path };
      });
    });
    if (report.workspace_suggestions !== undefined) {
      if (!Array.isArray(report.workspace_suggestions)) throw new Error('Invalid workspace suggestions');
      for (const suggestion of report.workspace_suggestions) {
        validateSuggestion(suggestion);
        if (suggestion.kind !== 'AdvisoryOverlap' || suggestion.package != null) {
          throw new Error('Invalid workspace suggestion scope');
        }
        findings.push({ ...suggestion, scope: 'workspace', package: null, packageVersion: null, manifest: null });
      }
    }
    if (policyTriggered && findings.length === 0) return failed;
    return { findings, packages: report.packages.length, version: report.cargo_anoint_version, policyTriggered, failed: false };
  } catch {
    return failed;
  }
}

function escapeMarkdown(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

// Fail closed for unavailable scans, explicit repository policy failures,
// and unresolved focused overlaps, even if a scanner unexpectedly exits zero.
export function anointGateFailure(report) {
  if (report.failed) return 'cargo-anoint unavailable or invalid report';
  const conflicts = report.findings.filter(finding => finding.kind === 'CapabilityOverlap');
  if (conflicts.length) return 'Unresolved dependency provider overlaps: ' +
    conflicts.map(f => f.package + ': ' + f.current).join('; ');
  if (report.policyTriggered) return 'Repository cargo-anoint failure policy triggered';
  return null;
}

export function summarizeAnoint(report) {
  const overlaps = report.findings.filter((finding) => finding.kind === 'CapabilityOverlap');
  const advisory = report.findings.filter((finding) => finding.kind === 'AdvisoryOverlap');
  const recommendations = report.findings.filter((finding) => finding.kind !== 'CapabilityOverlap' && finding.kind !== 'AdvisoryOverlap');
  const status = report.failed ? 'Unavailable (gate failed)' : anointGateFailure(report) ? 'Gate failed' : report.findings.length ? 'Review candidates' : 'No candidates';
  const row = '| Dependency consolidation / cargo-anoint | ' + report.findings.length + ' | ' + status + ' |';
  if (report.failed) return { row, lines: [] };
  const lines = [
    'Cargo-anoint ' + escapeMarkdown(report.version) + ': ' + report.packages + ' workspace member(s); ' +
      overlaps.length + ' potential capability overlaps, ' + advisory.length + ' advisory overlaps, ' + recommendations.length + ' other dependency recommendations.',
    '',
    'The scan includes all features and dependency roles across the Cargo platform union. Unexempted focused overlaps fail CI; workload-sensitive findings remain advisory. Review feature/target exclusivity and build/dev roles before consolidating.',
    '',
  ];
  if (report.policyTriggered) lines.push('The repository\'s own anoint.toml failure policy triggered. The mandatory scanner gate failed.', '');
  const impactRank = { High: 0, Medium: 1, Low: 2 };
  const ordered = [...overlaps, ...advisory, ...recommendations.sort((a, b) => impactRank[a.impact] - impactRank[b.impact])];
  for (const finding of ordered.slice(0, 40)) {
    lines.push('- **' + escapeMarkdown(finding.scope === 'workspace' ? 'Workspace' : finding.package) + '** [' + finding.kind + ', ' + finding.impact + ']: ' +
      escapeMarkdown(finding.current) + ' → ' + escapeMarkdown(finding.recommended) + '. ' + escapeMarkdown(finding.reason));
  }
  if (ordered.length > 40) lines.push('- …and ' + (ordered.length - 40) + ' more in the structured diagnostics');
  lines.push('');
  return { row, lines };
}
