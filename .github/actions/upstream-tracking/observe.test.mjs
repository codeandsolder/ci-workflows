import test from "node:test";
import assert from "node:assert/strict";
import { planObservation, QUARANTINE_MS } from "./observe.mjs";

const a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
const day = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 10, 22, 4);
const source = "owner/repo:main";
const linear = (x, y) => x <= y;

test("initial snapshot is quarantined and same-day dispatch is suppressed", () => {
  const first = planObservation(null, source, a, start, linear);
  assert.equal(first.eligible, null);
  assert.deepEqual(planObservation(first.state, source, b, start + 1000, linear), { skipped: true });
});

test("continuously moving upstream can progress at the exact 72-hour boundary", () => {
  const first = planObservation(null, source, a, start, linear);
  const second = planObservation(first.state, source, b, start + day, linear);
  const third = planObservation(second.state, source, c, start + 2 * day, linear);
  assert.equal(planObservation(third.state, source, c, start + QUARANTINE_MS - 1, linear).eligible, null);
  assert.equal(planObservation(third.state, source, c, start + QUARANTINE_MS, linear).eligible, a);
  assert.equal(planObservation(third.state, source, c, start + 4 * day, linear).eligible, b);
});

test("force-pushed and later reintroduced snapshots are observed afresh", () => {
  const first = planObservation(null, source, a, start, linear);
  const rewrite = planObservation(first.state, source, b, start + day, (x, y) => x === y);
  const restored = planObservation(rewrite.state, source, a, start + 4 * day, (x, y) => x === y);
  assert.equal(restored.eligible, null);
  assert.equal(restored.state.observations[0].firstObserved, start + 4 * day);
});

test("changing upstream resets the quarantine and commit timestamps are irrelevant", () => {
  const first = planObservation(null, source, a, start, linear);
  assert.equal(planObservation(first.state, "other/repo:main", a, start + 10 * day, linear).eligible, null);
  assert.throws(() => planObservation(first.state, source, a, start - 1, linear), /backwards/);
});
