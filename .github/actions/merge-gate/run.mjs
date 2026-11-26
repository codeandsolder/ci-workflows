import { evaluateGate } from './evaluate.mjs';

try {
  const { checked, problems } = evaluateGate(process.env.NEEDS_JSON, process.env.EXPECTED_RESULTS);
  if (problems.length !== 0) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else {
    console.log(`Merge gate: all ${checked} dependency results match the declared expectations.`);
  }
} catch (error) {
  console.error(`Merge gate: ${error.message}`);
  process.exitCode = 1;
}
