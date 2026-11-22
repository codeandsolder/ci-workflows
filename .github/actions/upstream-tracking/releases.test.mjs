import test from "node:test";
import assert from "node:assert/strict";
import { stableReleases, versionFromTag } from "./releases.mjs";
import { planObservation, QUARANTINE_MS } from "./observe.mjs";

const now = Date.UTC(2026, 10, 22);
const release = (tag_name, extras = {}) => ({ tag_name, published_at: new Date(now).toISOString(), ...extras });
test("crate release series is isolated from npm, prereleases and backports", () => {
  const tags = stableReleases([
    release("v99.0.0"), release("crate-v7.9.1"), release("crate-v7.10.0"),
    release("crate-v8.0.0", { draft: true }),
    release("crate-v9.0.0", { prerelease: true }),
    release("crate-v10.0.0-rc.1"), release("crate-v07.0.0"),
    release("crate-v11.0.0", { published_at: new Date(now + 1).toISOString() }),
  ], "crate-v", now).map(r => r.tag_name);
  assert.deepEqual(tags, ["crate-v7.10.0", "crate-v7.9.1"]);
  assert.equal(versionFromTag("crate-v7.10.0", "crate-v"), "7.10.0");
});
test("release tag identity is quarantined and retagging resets it", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  const source = "up:main:releases:crate-v";
  const first = planObservation(null, source, a, now, () => true, "crate-v1.0.0");
  const moved = planObservation(first.state, source, b, now + QUARANTINE_MS, () => true,
    "crate-v1.0.0", (commit) => commit === b);
  assert.equal(moved.eligible, null);
  const mature = planObservation(moved.state, source, b, now + 2 * QUARANTINE_MS, () => true,
    "crate-v1.0.0", (commit) => commit === b);
  assert.equal(mature.eligible, b);
  assert.equal(mature.eligibleTag, "crate-v1.0.0");
});
test("newer published release does not suppress already mature ancestor", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  const source = "up:main:releases:crate-v";
  const first = planObservation(null, source, a, now, () => true, "crate-v1.0.0");
  const second = planObservation(first.state, source, b, now + QUARANTINE_MS, () => true, "crate-v1.1.0");
  assert.equal(second.eligible, a);
  assert.equal(second.eligibleTag, "crate-v1.0.0");
});
