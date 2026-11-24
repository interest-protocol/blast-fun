import assert from "node:assert/strict";
import test from "node:test";
import {
  partnerCapacity,
  assertEntitlementCapacity,
  PartnerCapacityError,
  capacityFingerprint,
  preflightPerIpLimit,
} from "./capacity.ts";
export const syntheticCapacity = {
  maxReplicas: 2,
  internalMaxInflight: 8,
  maxEntries: 100,
  maxBytes: 65536,
  maxOrigins: 100,
  safeRequestsPerMinute: 20000,
  evidence: "local-synthetic-only",
  reserves: {
    preflight: 100,
    anonymous: 100,
    unknown: 100,
    admin: 100,
    internal: 100,
  },
  classifierInflight: 8,
  queueWaitMs: 100,
  tenants: ["quiet", "noisy"].map((id) => ({
    id,
    requestsPerMinute: 1200,
    keyRequestsPerMinute: 600,
    maxInflight: 8,
    queueLimit: 4,
  })),
};
test("capacity is explicit and cannot reduce existing entitlements to fit a reservation", () => {
  assert.throws(() => partnerCapacity(undefined));
  const capacity = partnerCapacity(JSON.stringify(syntheticCapacity));
  assertEntitlementCapacity(capacity, [
    { partner_id: "quiet", tier: "standard", requests_per_minute: 300 },
  ]);
  assert.throws(
    () =>
      assertEntitlementCapacity(capacity, [
        { partner_id: "quiet", tier: "custom", requests_per_minute: 601 },
      ]),
    PartnerCapacityError,
  );
  assert.throws(
    () =>
      assertEntitlementCapacity(
        capacity,
        Array.from({ length: 5 }, () => ({
          partner_id: "quiet",
          tier: "standard",
          requests_per_minute: 300,
        })),
      ),
    PartnerCapacityError,
  );
  assert.throws(() =>
    partnerCapacity(
      JSON.stringify({ ...syntheticCapacity, safeRequestsPerMinute: 400 }),
    ),
  );
  assert.throws(() =>
    partnerCapacity(JSON.stringify({ ...syntheticCapacity, maxReplicas: 32 })),
  );
});

test("optional per-network preflight limit keeps existing fingerprints and stays inside the reserve", () => {
  const existing = partnerCapacity(JSON.stringify(syntheticCapacity));
  // Pre-change fingerprint recorded in opus-resume-01/n1-n5/baseline-fingerprint.txt.
  assert.equal(
    capacityFingerprint(existing),
    "e234427dea51501f9de757c9a1053d3efb230f99d4cd2cf5ec6089f15f3c7120",
  );
  assert.equal(preflightPerIpLimit(existing), 25);
  const explicit = partnerCapacity(
    JSON.stringify({ ...syntheticCapacity, preflightPerIp: 40 }),
  );
  assert.equal(preflightPerIpLimit(explicit), 40);
  assert.notEqual(
    capacityFingerprint(explicit),
    capacityFingerprint(existing),
    "setting it is a config change",
  );
  assert.throws(() =>
    partnerCapacity(
      JSON.stringify({ ...syntheticCapacity, preflightPerIp: 101 }),
    ),
  );
  assert.throws(() =>
    partnerCapacity(
      JSON.stringify({
        ...syntheticCapacity,
        reserves: { ...syntheticCapacity.reserves, preflightPerIp: 10 },
      }),
    ),
  );
  assert.equal(
    preflightPerIpLimit(
      partnerCapacity(
        JSON.stringify({
          ...syntheticCapacity,
          reserves: { ...syntheticCapacity.reserves, preflight: 3 },
          safeRequestsPerMinute: 20000,
        }),
      ),
    ),
    1,
  );
});
