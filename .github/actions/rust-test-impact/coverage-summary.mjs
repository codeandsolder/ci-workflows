import { readFileSync, appendFileSync } from 'node:fs';

const { COVERAGE_JSON, COVERAGE_STATUS, COVERAGE_DIRECTORY, COVERAGE_ARTIFACT_URL, COVERAGE_ARTIFACT_SUBDIR, GITHUB_STEP_SUMMARY } = process.env;

const lines = [
  '## Rust test coverage (informational)',
  '',
  'Coverage is advisory: no percentage threshold and no required quality gate.',
  '',
  'Workspace: `' + (COVERAGE_DIRECTORY ?? '.').replaceAll('`', '\\`') + '`.',
  '',
];

if (COVERAGE_STATUS !== 'success') {
  lines.push('**Coverage execution did not complete successfully.** See the job logs for details.', '');
}

try {
  const report = JSON.parse(readFileSync(COVERAGE_JSON, 'utf8'));
  if (!Array.isArray(report.data) || report.data.length === 0) {
    throw new Error('LLVM JSON data is missing');
  }
  const metrics = [
    ['Lines', 'lines'],
    ['Functions', 'functions'],
    ['Regions', 'regions'],
    ['Branches', 'branches'],
  ];
  lines.push('| Metric | Covered | Total | Coverage |', '| --- | ---: | ---: | ---: |');
  for (const [label, key] of metrics) {
    const entries = report.data.map((entry) => entry.totals?.[key]).filter(Boolean);
    if (entries.length === 0) continue;
    const covered = entries.reduce((total, entry) => total + entry.covered, 0);
    const count = entries.reduce((total, entry) => total + entry.count, 0);
    if (!Number.isSafeInteger(covered) || !Number.isSafeInteger(count) || covered < 0 || count < covered) {
      throw new Error('Invalid LLVM coverage totals for ' + key);
    }
    lines.push(`| ${label} | ${covered.toLocaleString('en-US')} | ${count.toLocaleString('en-US')} | ${count ? (100 * covered / count).toFixed(1) + '%' : 'N/A'} |`);
  }
  lines.push('');
} catch (error) {
  lines.push('Coverage totals unavailable: ' + error.message.replaceAll('\n', ' '), '');
}

if (COVERAGE_ARTIFACT_URL) {
  const reportPath = COVERAGE_ARTIFACT_SUBDIR ? COVERAGE_ARTIFACT_SUBDIR + '/html/index.html' : 'html/index.html';
  lines.push(`[Download the HTML and LCOV report](${COVERAGE_ARTIFACT_URL}) (open \`${reportPath}\` inside the artifact).\n`);
}

const markdown = lines.join('\n') + '\n';
if (GITHUB_STEP_SUMMARY) {
  appendFileSync(GITHUB_STEP_SUMMARY, markdown);
} else {
  process.stdout.write(markdown);
}
