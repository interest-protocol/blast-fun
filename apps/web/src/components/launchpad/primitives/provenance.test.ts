import assert from "node:assert/strict";
import test from "node:test";

import { describeProvenance, formatLag } from "./provenance.ts";

const DEPLOYMENT = "0x5b1a0c9e4f7d2a36b8c1e0f9a7d6c5b4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8";

test("provenance names network, deployment, checkpoint, observation time and lag", () => {
  assert.deepEqual(
    describeProvenance({
      network: "mainnet",
      deployment: DEPLOYMENT,
      checkpoint: "182734455",
      observedAt: "2026-09-30T14:02:11.000Z",
      lagMs: 2400,
    }),
    [
      { term: "Network", value: "Sui mainnet" },
      { term: "Deployment", value: "0x5b1a…a9b8", full: DEPLOYMENT },
      { term: "Checkpoint", value: "182,734,455" },
      { term: "Observed", value: "2026-09-30 14:02:11 UTC", dateTime: "2026-09-30T14:02:11.000Z" },
      { term: "Lag", value: "2.4 s behind" },
    ],
  );
});

test("unreported provenance reads Unknown instead of zero", () => {
  assert.deepEqual(
    describeProvenance({
      network: null,
      deployment: null,
      checkpoint: null,
      observedAt: "yesterday",
      lagMs: null,
    }).map(({ term, value }) => [term, value]),
    [
      ["Network", "Unknown"],
      ["Deployment", "Unknown"],
      ["Checkpoint", "Unknown"],
      ["Observed", "Unknown"],
      ["Lag", "Unknown"],
    ],
  );
});

test("short deployment fingerprints are shown whole", () => {
  const [, deployment] = describeProvenance({
    network: "testnet",
    deployment: "blast-v2@7687eda",
    checkpoint: "12",
    observedAt: null,
    lagMs: 0,
  });
  assert.deepEqual(deployment, { term: "Deployment", value: "blast-v2@7687eda" });
});

test("lag reads in the largest useful units and rejects impossible values", () => {
  assert.equal(formatLag(0), "Under 1 s behind");
  assert.equal(formatLag(999), "Under 1 s behind");
  assert.equal(formatLag(12_000), "12 s behind");
  assert.equal(formatLag(243_000), "4 min 3 s behind");
  assert.equal(formatLag(7_500_000), "2 h 5 min behind");
  assert.equal(formatLag(-5), "Unknown");
  assert.equal(formatLag(Number.NaN), "Unknown");
  assert.equal(formatLag(null), "Unknown");
});
