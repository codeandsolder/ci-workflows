// Evaluate GitHub's native dependency results, never an external run inventory.
const jobId = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const expectedStates = new Set(['success', 'skipped']);
const observedStates = new Set(['success', 'skipped', 'failure', 'cancelled']);

function parse(input, label) {
  try {
    return JSON.parse(input);
  } catch {
    // Do not include JSON snippets: needs can contain job outputs.
    throw new Error(`${label} must be valid JSON`);
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function evaluateGate(needsJson, expectedJson) {
  const needs = parse(needsJson, 'needs');
  const entries = parse(expectedJson, 'expected-results');
  if (!record(needs)) throw new Error('needs must be a JSON object');
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('expected-results must be a nonempty array of [job, result] pairs');
  }
  const expected = new Map();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' ||
        !jobId.test(entry[0]) || !expectedStates.has(entry[1])) {
      throw new Error('expected-results entries must identify a job and success or skipped');
    }
    const [id, result] = entry;
    if (expected.has(id)) throw new Error(`Duplicate expected job: ${id}`);
    expected.set(id, result);
  }
  if (![...expected.values()].includes('success')) {
    throw new Error('At least one dependency must be required to succeed');
  }

  const problems = [];
  for (const [id, required] of expected) {
    if (!Object.hasOwn(needs, id)) {
      problems.push(`${id}: missing dependency result`);
      continue;
    }
    const value = needs[id];
    if (!record(value) || !Object.hasOwn(value, 'result') || !observedStates.has(value.result)) {
      problems.push(`${id}: malformed or unknown result`);
      continue;
    }
    if (value.result !== required) {
      problems.push(`${id}: expected ${required}, got ${value.result}`);
    }
  }
  for (const id of Object.keys(needs)) {
    if (!jobId.test(id)) {
      problems.push('Unexpected malformed dependency identifier');
    } else if (!expected.has(id)) {
      problems.push(`${id}: unexpected dependency without an expectation`);
    }
  }
  return { checked: expected.size, problems };
}
