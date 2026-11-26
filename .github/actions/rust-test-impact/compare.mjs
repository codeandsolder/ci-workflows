import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';

function testKey(binaryId, testName) {
  return binaryId + '\u0000' + testName;
}

function binaryId(suite) {
  const info = suite?.nextest;
  if (!info || typeof info.crate !== 'string' || typeof info.test_binary !== 'string') {
    throw new Error('Nextest suite lacks crate and test-binary identity');
  }
  if (info.kind === 'lib' || info.kind === 'proc-macro') return info.crate;
  if (info.kind === 'test') return info.crate + '::' + info.test_binary;
  if (['bin', 'example', 'bench'].includes(info.kind)) return info.crate + '::' + info.kind + '/' + info.test_binary;
  throw new Error('Unknown Nextest binary kind ' + JSON.stringify(info.kind));
}

export function compareImpact(selection, nextestLines, fullRunSucceeded) {
  const suiteIds = new Map();
  const events = [];
  for (const line of nextestLines.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    if (item.type === 'suite' && item.event === 'started') {
      const key = item.nextest?.crate + '::' + item.nextest?.test_binary;
      if (suiteIds.has(key) && suiteIds.get(key) !== binaryId(item)) {
        throw new Error('Ambiguous Nextest binary identity ' + key);
      }
      suiteIds.set(key, binaryId(item));
    }
    if (item.type === 'test' && typeof item.name === 'string') events.push(item);
  }
  const outcomes = new Map();
  for (const event of events) {
    const sep = event.name.indexOf('$');
    if (sep < 1) throw new Error('Unrecognized Nextest test name: ' + event.name);
    const id = suiteIds.get(event.name.slice(0, sep));
    if (!id) throw new Error('Test ' + event.name + ' lacks a matching Nextest suite');
    const name = event.name.slice(sep + 1);
    if (!name) throw new Error('Missing test name in ' + event.name);
    if (event.event !== 'started') outcomes.set(testKey(id, name), {
      binaryId: id, testName: name, event: event.event,
      seconds: typeof event.exec_time === 'number' && Number.isFinite(event.exec_time) && event.exec_time >= 0
        ? event.exec_time : null,
    });
  }
  const executed = [...outcomes.entries()].filter(([, outcome]) => !['ignored', 'filtered'].includes(outcome.event));
  const failures = executed.filter(([, outcome]) => outcome.event !== 'ok');
  const measured = executed.filter(([, outcome]) => outcome.seconds !== null);
  const sumSeconds = rows => rows.reduce((sum, [, outcome]) => sum + outcome.seconds, 0);
  const timing = {
    timedTests: measured.length,
    executionSeconds: measured.length === executed.length && executed.length ? sumSeconds(measured) : null,
    selectedExecuted: null,
    selectedExecutionSeconds: null,
    skippedExecutionSeconds: null,
  };
  if (!executed.length || (!fullRunSucceeded && failures.length === 0)) {
    const reason = executed.length
      ? 'Full Nextest failed without an individual failing-test outcome'
      : 'Full Nextest run produced no test outcomes';
    return { evaluable: false, reason, total: executed.length, failed: failures.length, ...timing, misses: [] };
  }
  const cache = selection?.cache?.status;
  const summary = selection?.selection?.summary;
  const selectedTests = selection?.selection?.selected_tests;
  const evaluable = typeof cache === 'string' && cache.startsWith('hit-')
    && summary?.mode === 'selection' && Array.isArray(selectedTests);
  const selected = new Set();
  if (evaluable) {
    for (const item of selectedTests) {
      if (typeof item.binary_id !== 'string' || typeof item.test_name !== 'string') {
        throw new Error('Selected-test report contains invalid identity');
      }
      selected.add(testKey(item.binary_id, item.test_name));
    }
  }
  const misses = evaluable
    ? failures.filter(([key]) => !selected.has(key)).map(([, { binaryId, testName, event }]) => ({ binaryId, testName, event }))
    : [];
  if (evaluable) {
    const selectedOutcomes = executed.filter(([key]) => selected.has(key));
    timing.selectedExecuted = selectedOutcomes.length;
    if (timing.executionSeconds !== null) {
      timing.selectedExecutionSeconds = sumSeconds(selectedOutcomes);
      timing.skippedExecutionSeconds = sumSeconds(executed.filter(([key]) => !selected.has(key)));
    }
  }
  return {
    evaluable,
    reason: evaluable ? null : 'Selection unavailable or incompatible (cache=' + (cache ?? 'none')
      + ', mode=' + (summary?.mode ?? 'none') + ')',
    cacheStatus: cache ?? null,
    total: executed.length,
    ...timing,
    failed: failures.length,
    selected: evaluable ? selected.size : null,
    misses,
  };
}

export function renderSummary(assessment) {
  const tick = String.fromCharCode(96);
  const lines = [
    '## Rust test-impact shadow (informational)',
    '',
    'The full Nextest suite remains the authoritative regression gate.',
    '',
    'Full Nextest: ' + assessment.total + ' completed tests, ' + assessment.failed + ' failures.',
  ];
  if (assessment.executionSeconds !== null && assessment.executionSeconds !== undefined) {
    lines.push('Observed terminal-attempt test time (summed, not job wall time): ' + assessment.executionSeconds.toFixed(2) + ' s.');
  }
  if (!assessment.evaluable) {
    lines.push('Test-impact selection not evaluable: ' + assessment.reason + '.');
  } else {
    lines.push('Selected by cargo-affected: ' + assessment.selected + ' tests; potential missed regressions: ' + assessment.misses.length + '.');
    if (assessment.selectedExecuted !== null && assessment.selectedExecuted !== undefined) {
      lines.push('Among the executed tests, ' + assessment.selectedExecuted + '/' + assessment.total + ' would be selected.');
    }
    if (assessment.skippedExecutionSeconds !== null && assessment.skippedExecutionSeconds !== undefined) {
      const saved = assessment.executionSeconds > 0 ? 100 * assessment.skippedExecutionSeconds / assessment.executionSeconds : 0;
      lines.push('Estimated avoidable summed test time: ' + assessment.skippedExecutionSeconds.toFixed(2)
        + ' s (' + saved.toFixed(1) + '%). This is not a measured CI speedup.');
    }
    for (const miss of assessment.misses.slice(0, 30)) {
      lines.push('- Potential false negative: ' + tick + miss.binaryId + '::' + miss.testName + tick + ' (' + miss.event + ').');
    }
    if (assessment.misses.length > 30) lines.push((assessment.misses.length - 30) + ' additional misses omitted.');
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1]?.endsWith('/compare.mjs')) {
  try {
    let report;
    try {
      report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      report = { cache: { status: 'miss-no-coverage' } };
    }
    const nextest = readFileSync(process.argv[3], 'utf8');
    const result = compareImpact(report, nextest, process.argv[4] === 'true');
    const summary = renderSummary(result);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    else process.stdout.write(summary);
    if (process.argv[5]) writeFileSync(process.argv[5], JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    const message = 'Test-impact comparison unavailable: ' + error.message + '\n';
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, message);
    else process.stderr.write(message);
    process.exitCode = 2;
  }
}
