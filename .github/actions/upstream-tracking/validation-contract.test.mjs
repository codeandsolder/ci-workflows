import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../../workflows/upstream-tracking.yml', import.meta.url), 'utf8');

test('upstream candidates use the reviewed fork validator, not first-party source policy', () => {
  const validation = workflow.slice(workflow.indexOf('\n  validate:'), workflow.indexOf('\n  publish:'));
  assert.match(validation, /git show "HEAD:\$VALIDATOR" > "\$RUNNER_TEMP\/validate-upstream.sh"/);
  assert.match(validation, /bash "\$RUNNER_TEMP\/validate-upstream.sh" "\$\{args\[@\]\}"/);
  assert.match(validation, /git diff --exit-code HEAD --/);
  assert.ok(validation.indexOf('Run reviewed fork validation') < validation.indexOf('Record exactly validated revision'));
  assert.doesNotMatch(validation, /strict-plan|run-strict|rust-skills2|clone-regression/);
  assert.match(validation, /cargo-release-quarantine/);
  assert.match(validation, /setup-sccache/);
  assert.match(workflow.slice(workflow.indexOf('\n  publish:')), /needs\.validate\.result == 'success'/);
});
