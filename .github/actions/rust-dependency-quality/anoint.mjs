const kinds = new Set(['ModernAlternative', 'FeatureOptimization', 'StdReplacement', 'ComboWin', 'CapabilityOverlap', 'Unmaintained']);
const impacts = new Set(['High', 'Medium', 'Low']);

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
        if (!kinds.has(suggestion.kind) || !impacts.has(suggestion.impact) ||
            ['current', 'recommended', 'reason'].some((key) => typeof suggestion[key] !== 'string')) {
          throw new Error('Invalid dependency suggestion');
        }
        return { ...suggestion, package: pkg.name, packageVersion: pkg.version, manifest: pkg.manifest_path };
      });
    });
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

export function summarizeAnoint(report) {
  const overlaps = report.findings.filter((finding) => finding.kind === 'CapabilityOverlap');
  const recommendations = report.findings.filter((finding) => finding.kind !== 'CapabilityOverlap');
  const status = report.failed ? 'Unavailable' : report.findings.length ? 'Review candidates' : 'No candidates';
  const row = '| Dependency consolidation / cargo-anoint | ' + report.findings.length + ' | ' + status + ' |';
  if (report.failed) return { row, lines: [] };
  const lines = [
    'Cargo-anoint ' + escapeMarkdown(report.version) + ': ' + report.packages + ' workspace member(s); ' +
      overlaps.length + ' potential capability overlaps, ' + recommendations.length + ' other dependency recommendations.',
    '',
    'The scan includes all features and dependency roles across the Cargo platform union. Check feature/target exclusivity and build/dev roles before consolidating; findings are advisory.',
    '',
  ];
  if (report.policyTriggered) lines.push('The repository\'s own anoint.toml failure policy triggered. This shared report remains informational.', '');
  const impactRank = { High: 0, Medium: 1, Low: 2 };
  const ordered = [...overlaps, ...recommendations.sort((a, b) => impactRank[a.impact] - impactRank[b.impact])];
  for (const finding of ordered.slice(0, 40)) {
    lines.push('- **' + escapeMarkdown(finding.package) + '** [' + finding.kind + ', ' + finding.impact + ']: ' +
      escapeMarkdown(finding.current) + ' → ' + escapeMarkdown(finding.recommended) + '. ' + escapeMarkdown(finding.reason));
  }
  if (ordered.length > 40) lines.push('- …and ' + (ordered.length - 40) + ' more in the structured diagnostics');
  lines.push('');
  return { row, lines };
}
