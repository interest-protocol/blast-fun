/** Synthetic admission envelope for disposable local fixtures, never a hosting recommendation. */
export function capacityFixture(ids: readonly string[], queueLimit = 16) {
  return JSON.stringify({
    maxReplicas: 2,
    internalMaxInflight: 8,
    maxEntries: 20000,
    maxBytes: 4194304,
    maxOrigins: 1000,
    safeRequestsPerMinute: ids.length * 4_000_000 + 40_000,
    evidence: "disposable-local-fixture-not-production-capacity",
    reserves: {
      preflight: 100,
      anonymous: 10000,
      unknown: 3000,
      admin: 1000,
      internal: 10000,
    },
    classifierInflight: 32,
    queueWaitMs: 500,
    tenants: ids.map((id) => ({
      id,
      requestsPerMinute: 4_000_000,
      keyRequestsPerMinute: 100000,
      maxInflight: 32,
      queueLimit,
    })),
  });
}
