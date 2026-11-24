import assert from "node:assert/strict";
import test from "node:test";

import { readMarketData, type MarketDataDependencies } from "./market-data.ts";

const NOW = 1_790_000_000_000;
const ORIGIN = "https://api.blast.test";
const FINGERPRINT = "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c";

type Reply = { status: number; body: unknown } | Error;

/** blast-infra's `provenance`: served at NOW, its checkpoint `lagMs` old. */
const provenance = (
  lagMs: number | null,
  checkpoint: number | null = 326_274_009,
  network = "mainnet",
  fingerprint = FINGERPRINT,
) => ({
  network,
  deployment_fingerprint: fingerprint,
  checkpoint,
  timestamp_ms: lagMs === null ? null : NOW - lagMs,
  observed_ms: NOW,
  lag_ms: lagMs,
});
const pools = (
  lagMs: number | null = 412,
  network = "mainnet",
  fingerprint = FINGERPRINT,
  checkpoint: number | null = 326_274_009,
) => ({
  provenance: provenance(lagMs, checkpoint, network, fingerprint),
  pools: [{ pool_key: "0xpool" }],
  next_cursor: null,
});
const expected = { network: "mainnet", deployment: FINGERPRINT } as const;

function blastInfra(
  replies: Record<string, Reply>,
  overrides: Partial<MarketDataDependencies> = {},
): MarketDataDependencies & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    origin: ORIGIN,
    now: () => NOW,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected,
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      requested.push(url);
      const reply = replies[url.slice(ORIGIN.length)];
      if (!reply) throw new Error(`unexpected ${url}`);
      if (reply instanceof Error) throw reply;
      return Response.json(reply.body, { status: reply.status });
    },
    ...overrides,
  };
}

const status = (lagMs: number | null, checkpoint: number | null = 326_274_009) => ({
  status: 200,
  body: {
    provenance: provenance(lagMs, checkpoint),
    checkpoint,
    timestamp_ms: lagMs === null ? null : NOW - lagMs,
    lag_ms: lagMs,
    cursor: null,
    engine_id: "aws-1",
  },
});

const PROVENANCE = {
  source: "blast-infra",
  network: "mainnet",
  deployment: FINGERPRINT,
  checkpoint: 326_274_009,
  timestampMs: NOW - 412,
  observedAt: NOW,
  lagMs: 412,
};

test("a market read names the deployment, checkpoint, observation and lag its own answer carries", async () => {
  const body = pools();
  const deps = blastInfra({ "/v1/pools?limit=20": { status: 200, body } });
  assert.deepEqual(await readMarketData("discovery-market-facts", "/v1/pools?limit=20", deps), {
    status: "fresh",
    data: { httpStatus: 200, body },
    provenance: PROVENANCE,
  });
  assert.deepEqual(deps.requested, [`${ORIGIN}/v1/pools?limit=20`], "no separate status probe");
});

test("a lagging or halted blast-infra is served stale with provenance, never recomputed", async () => {
  const body = pools(41_250);
  const deps = blastInfra({ "/v1/coins/0x2%3A%3Ameme%3A%3AMEME": { status: 200, body } });
  assert.deepEqual(await readMarketData("market", "/v1/coins/0x2%3A%3Ameme%3A%3AMEME", deps), {
    status: "stale",
    data: { httpStatus: 200, body },
    provenance: { ...PROVENANCE, timestampMs: NOW - 41_250, lagMs: 41_250, reason: "lagging" },
  });
});

test("a starting, unreachable, failing, key-refusing or unprovable blast-infra is unavailable, not empty or zero", async () => {
  const notReady = { status: 503, body: { error: { code: "not_ready", message: "engine is starting" } } };
  const unproven: Record<string, unknown> = pools();
  delete unproven.provenance;
  for (const [reply, reason] of [
    [notReady, "not_ready"],
    [new TypeError("fetch failed"), "unreachable"],
    [{ status: 502, body: "Bad Gateway" }, "http_502"],
    // A refusal of this server's key is not an answer: no /v1/status provenance is borrowed for it.
    [{ status: 401, body: { error: { code: "unauthorized", message: "a valid API key is required" } } }, "unauthorized"],
    [{ status: 403, body: { error: { code: "forbidden", message: "key revoked" } } }, "unauthorized"],
    [{ status: 200, body: pools(null, "mainnet", FINGERPRINT, null) }, "no_checkpoint"],
    [{ status: 200, body: unproven }, "provenance-invalid"],
    [{ status: 200, body: { ...pools(), provenance: { ...provenance(5), lag_ms: "5" } } }, "provenance-invalid"],
  ] as const) {
    const result = await readMarketData("market", "/v1/pools", blastInfra({ "/v1/pools": reply }));
    assert.equal(result.status, "unavailable", reason);
    assert.equal(result.provenance.source, "blast-infra");
    assert.equal(result.provenance.reason, reason);
    assert.equal("data" in result, false, reason);
  }
});

test("an answer about another deployment or network is unavailable", async () => {
  // The expectation is always mainnet; the answer names something else.
  for (const [answer, reason] of [
    [pools(412, "testnet"), "network-mismatch"],
    [pools(412, "mainnet", "0".repeat(64)), "deployment-mismatch"],
  ] as const) {
    const result = await readMarketData(
      "market",
      "/v1/pools",
      blastInfra({ "/v1/pools": { status: 200, body: answer } }, { expected }),
    );
    assert.equal(result.status, "unavailable", reason);
    assert.equal(result.provenance.reason, reason);
    assert.equal(result.provenance.checkpoint, 326_274_009, "the answer's own checkpoint is reported");
  }
});

test("a request blast-infra refuses is its answer, with the engine's provenance from /v1/status", async () => {
  const notFound = { error: { code: "not_found", message: "no such pool" } };
  const result = await readMarketData(
    "market",
    "/v1/pools/blast_curve/0x0",
    blastInfra({ "/v1/pools/blast_curve/0x0": { status: 404, body: notFound }, "/v1/status": status(5) }),
  );
  assert.deepEqual(result, {
    status: "fresh",
    data: { httpStatus: 404, body: notFound },
    provenance: { ...PROVENANCE, timestampMs: NOW - 5, lagMs: 5 },
  });

  const unknown = await readMarketData(
    "market",
    "/v1/pools/blast_curve/0x0",
    blastInfra({ "/v1/pools/blast_curve/0x0": { status: 404, body: notFound }, "/v1/status": new Error("socket hang up") }),
  );
  assert.deepEqual(unknown, {
    status: "stale",
    data: { httpStatus: 404, body: notFound },
    provenance: {
      source: "blast-infra", network: null, deployment: null, checkpoint: null, timestampMs: null,
      observedAt: NOW, lagMs: null, reason: "status-unavailable",
    },
  });
});

test("only /v1 paths are read, so the origin cannot be swapped", async () => {
  const deps = blastInfra({});
  for (const path of ["https://evil.test/v1/pools", "//evil.test/v1/pools", "/v2/pools", "/v1/../admin"]) {
    await assert.rejects(readMarketData("market", path, deps), /blast-infra \/v1 path/, path);
  }
  assert.deepEqual(deps.requested, []);
});

test("one /v1/status read per origin serves the refusals of the next second", async () => {
  const notFound = { status: 404, body: { error: { code: "not_found", message: "no" } } };
  const deps = {
    ...blastInfra({ "/v1/pools/x/y": notFound, "/v1/status": status(10) }),
    statusCacheMs: 1_000,
    origin: "https://cache.blast.test",
  };
  deps.fetch = (async (input: string | URL | Request) => {
    deps.requested.push(String(input));
    const path = String(input).slice(deps.origin.length);
    return path === "/v1/status" ? Response.json(status(10).body) : Response.json(notFound.body, { status: 404 });
  }) as typeof fetch;
  await readMarketData("market", "/v1/pools/x/y", deps);
  await readMarketData("market", "/v1/pools/x/y", deps);
  assert.equal(deps.requested.filter((url) => url.endsWith("/v1/status")).length, 1);
});
