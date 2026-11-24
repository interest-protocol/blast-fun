import assert from "node:assert/strict";
import test from "node:test";

import {
  DATA_STATE_KINDS,
  ageSectionState,
  dataStatePresentation,
  refreshFailed,
  type SectionState,
} from "./data-state.ts";

const provenance = {
  network: "mainnet",
  deployment: "0x5b1a0c9e4f7d2a36b8c1e0f9a7d6c5b4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8",
  checkpoint: "182734455",
  observedAt: "2026-09-30T14:02:11.000Z",
  lagMs: 2400,
} as const;

test("loading, empty, unavailable and stale have distinct labels, shapes and meanings", () => {
  const presented = DATA_STATE_KINDS.map((kind) => dataStatePresentation(kind));
  assert.deepEqual(
    presented.map((state) => state.label),
    ["Loading", "Empty", "Unavailable", "Delayed"],
  );
  assert.equal(new Set(presented.map((state) => state.glyph)).size, 4, "each state has its own shape");
  assert.deepEqual(
    presented.map((state) => state.showsFacts),
    [false, false, false, true],
    "only stale keeps facts on screen",
  );
  assert.deepEqual(presented.map((state) => state.busy), [true, false, false, false]);
});

test("a failed refresh keeps the last valid facts only as Stale", () => {
  const ready: SectionState<number> = { status: "ready", value: 1284, provenance };
  assert.deepEqual(refreshFailed(ready, "Indexer timed out"), {
    status: "stale",
    value: 1284,
    provenance,
    reason: "Indexer timed out",
  });
});

test("a failed refresh without verified facts is Unavailable, never zero or sample data", () => {
  for (const previous of [
    { status: "loading" },
    { status: "empty", provenance },
    { status: "unavailable", reason: "Earlier failure" },
  ] as SectionState<number>[]) {
    const next = refreshFailed(previous, "Indexer timed out");
    assert.deepEqual(next, { status: "unavailable", reason: "Indexer timed out" });
    assert.equal("value" in next, false);
  }
});

test("facts older than the allowed age become Stale with their original provenance", () => {
  const ready: SectionState<string> = { status: "ready", value: "facts", provenance };
  const observed = Date.parse(provenance.observedAt);
  assert.equal(ageSectionState(ready, observed + 30_000, 30_000), ready);
  assert.deepEqual(ageSectionState(ready, observed + 30_001, 30_000), {
    status: "stale",
    value: "facts",
    provenance,
    reason: "Not refreshed for more than 30 s",
  });
});

test("facts with an unreadable observation time are Stale rather than presumed fresh", () => {
  const ready: SectionState<string> = {
    status: "ready",
    value: "facts",
    provenance: { ...provenance, observedAt: "not a time" },
  };
  assert.deepEqual(ageSectionState(ready, Date.now(), 30_000), {
    status: "stale",
    value: "facts",
    provenance: ready.provenance,
    reason: "Observation time unknown",
  });
});
