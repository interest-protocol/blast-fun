import assert from "node:assert/strict";
import test from "node:test";

import { ContractViolation } from "./decimal.ts";
import {
  deploymentMismatch,
  expectedDeployment,
  freshness,
  parseInfraProvenance,
  parseWatermarkRow,
} from "./provenance.ts";

const FINGERPRINT = "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c";
const WIRE = {
  network: "mainnet",
  deployment_fingerprint: FINGERPRINT,
  checkpoint: 326_274_009,
  timestamp_ms: 1_790_235_061_218,
  observed_ms: 1_790_235_061_630,
  lag_ms: 412,
};

test("blast-infra's provenance becomes the section's network, deployment, checkpoint, observation and lag", () => {
  assert.deepEqual(parseInfraProvenance(WIRE), {
    source: "blast-infra",
    network: "mainnet",
    deployment: FINGERPRINT,
    checkpoint: 326_274_009,
    timestampMs: 1_790_235_061_218,
    observedAt: 1_790_235_061_630,
    lagMs: 412,
  });
  assert.deepEqual(
    parseInfraProvenance({ ...WIRE, checkpoint: null, timestamp_ms: null, lag_ms: null }),
    {
      source: "blast-infra",
      network: "mainnet",
      deployment: FINGERPRINT,
      checkpoint: null,
      timestampMs: null,
      observedAt: 1_790_235_061_630,
      lagMs: null,
    },
  );
});

test("live frames' engine hop stamps are accepted and never become data", () => {
  const hops = { arrived_ms: 1, r2_put_ms: 38, intake_committed_ms: 2, written_ms: 3, picked_ms: 4, relay_ms: 5 };
  assert.deepEqual(parseInfraProvenance({ ...WIRE, hops }), parseInfraProvenance(WIRE));
  for (const bad of [[], { picked_ms: -1 }, { picked_ms: 1.5 }, { "Bad-Key": 1 }, { picked_ms: "1" }]) {
    assert.throws(() => parseInfraProvenance({ ...WIRE, hops: bad }), ContractViolation, JSON.stringify(bad));
  }
});

test("a provenance that breaks the contract is refused, never defaulted", () => {
  for (const bad of [
    undefined,
    { ...WIRE, network: "Main net" },
    { ...WIRE, deployment_fingerprint: FINGERPRINT.toUpperCase() },
    { ...WIRE, checkpoint: "326274009" },
    { ...WIRE, observed_ms: null },
    { ...WIRE, lag_ms: -1 },
    { ...WIRE, checkpoint: null },
    { ...WIRE, extra: true },
  ]) {
    assert.throws(() => parseInfraProvenance(bad), ContractViolation, JSON.stringify(bad));
  }
});

test("a replica watermark row carries the same provenance, read on the database's clock", () => {
  const row = {
    network: "mainnet",
    deployment_fingerprint: FINGERPRINT,
    chain_id: "35834a8a",
    checkpoint: "326274009",
    timestamp_ms: "1790235061218",
    observed_ms: "1790235061630",
    lag_ms: "412",
  };
  assert.deepEqual(parseWatermarkRow(row, "replica"), {
    source: "replica",
    network: "mainnet",
    deployment: FINGERPRINT,
    checkpoint: 326_274_009,
    timestampMs: 1_790_235_061_218,
    observedAt: 1_790_235_061_630,
    lagMs: 412,
  });
  // Before blast-infra commits a checkpoint.
  assert.deepEqual(
    parseWatermarkRow({ ...row, chain_id: null, checkpoint: null, timestamp_ms: null, lag_ms: null }, "primary"),
    {
      source: "primary",
      network: "mainnet",
      deployment: FINGERPRINT,
      checkpoint: null,
      timestampMs: null,
      observedAt: 1_790_235_061_630,
      lagMs: null,
    },
  );
  // No row: blast-infra never started on this database.
  assert.throws(() => parseWatermarkRow(undefined, "replica"), ContractViolation);
  assert.throws(() => parseWatermarkRow({ ...row, checkpoint: "-1" }, "replica"), ContractViolation);
});

test("freshness is the committed checkpoint's lag against the section's policy", () => {
  const provenance = parseInfraProvenance(WIRE);
  assert.equal(freshness(provenance, 30_000), "fresh");
  assert.equal(freshness(provenance, 100), "stale");
  assert.equal(freshness({ ...provenance, checkpoint: null, lagMs: null }, 30_000), "no-checkpoint");
});

test("a provenance for another deployment or network is a mismatch; an unset expectation checks nothing", () => {
  const provenance = parseInfraProvenance(WIRE);
  assert.equal(deploymentMismatch(provenance, { network: "mainnet", deployment: FINGERPRINT }), null);
  assert.equal(
    deploymentMismatch({ ...provenance, network: "moonnet" }, { network: "mainnet", deployment: FINGERPRINT }),
    "network-mismatch",
  );
  assert.equal(
    deploymentMismatch(provenance, { network: "mainnet", deployment: "0".repeat(64) }),
    "deployment-mismatch",
  );
  assert.equal(deploymentMismatch(provenance, null), null);
});

test("the expected deployment comes from BLAST_NETWORK and BLAST_DEPLOYMENT_FINGERPRINT together", () => {
  assert.equal(expectedDeployment({}), null);
  assert.deepEqual(
    expectedDeployment({ BLAST_NETWORK: "mainnet", BLAST_DEPLOYMENT_FINGERPRINT: FINGERPRINT }),
    { network: "mainnet", deployment: FINGERPRINT },
  );
  for (const environment of [
    { BLAST_NETWORK: "mainnet" },
    { BLAST_DEPLOYMENT_FINGERPRINT: FINGERPRINT },
    { BLAST_NETWORK: "moonnet", BLAST_DEPLOYMENT_FINGERPRINT: FINGERPRINT },
    { BLAST_NETWORK: "mainnet", BLAST_DEPLOYMENT_FINGERPRINT: "abc" },
  ]) {
    assert.throws(() => expectedDeployment(environment), /BLAST_NETWORK/, JSON.stringify(environment));
  }
});

test("presales-only infra may have no launchpad fingerprint; an expected deployment still rejects it", () => {
  const provenance = parseInfraProvenance({ ...WIRE, deployment_fingerprint: null });
  assert.equal(provenance.deployment, null);
  assert.equal(deploymentMismatch(provenance, { network: "mainnet", deployment: FINGERPRINT }), "deployment-mismatch");
});
