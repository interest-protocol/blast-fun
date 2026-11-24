import assert from "node:assert/strict";
import test from "node:test";

import { atCheckpoint, BEHIND_RETRY_MS, BROWSER_V1_ORIGIN, browserMarketDependencies, MARKET_ROUTE_PREFIX, marketRoute, POLL_MS } from "./blast-infra-browser";

test("a /v1 read becomes this app's same-origin market route, with its query; nothing else is fetched", () => {
  assert.equal(MARKET_ROUTE_PREFIX, "/api/launchpad/market");
  assert.equal(marketRoute(`${BROWSER_V1_ORIGIN}/v1/status`), "/api/launchpad/market/status");
  assert.equal(
    marketRoute(new URL(`${BROWSER_V1_ORIGIN}/v1/coins/0x${"a".repeat(64)}::coin::COIN/holders?view=snapshot&limit=25`)),
    `/api/launchpad/market/coins/0x${"a".repeat(64)}::coin::COIN/holders?view=snapshot&limit=25`,
  );
  for (const other of ["https://infra.example/v1/status", `${BROWSER_V1_ORIGIN}/v2/status`, `${BROWSER_V1_ORIGIN}/api/x`]) {
    assert.throws(() => marketRoute(other), /only to this app's \/api\/launchpad\/market routes/, other);
  }
  assert.equal(POLL_MS, 15_000);
});

test("the browser's /v1 dependencies read this app's routes, with a 3 s timeout and an unbound fetch", async () => {
  const calls: { self: unknown; input: unknown }[] = [];
  const fetcher = function (this: unknown, input: unknown) {
    calls.push({ self: this, input });
    return Promise.resolve(new Response("{}"));
  } as unknown as typeof fetch;
  const expected = { network: "mainnet", deployment: "0xabc" } as const;
  const dependencies = browserMarketDependencies(expected, fetcher, () => 42);
  assert.equal(dependencies.origin, BROWSER_V1_ORIGIN);
  assert.equal(dependencies.timeoutMs, 3_000);
  assert.equal(dependencies.statusCacheMs, 1_000);
  assert.equal(dependencies.now(), 42);
  assert.deepEqual(dependencies.expected, expected);
  await dependencies.fetch(`${BROWSER_V1_ORIGIN}/v1/status`);
  assert.deepEqual(calls, [{ self: undefined, input: "/api/launchpad/market/status" }], "fetch is called unbound, as browsers require, on the relative route");
});

test("a hinted read names its checkpoint on every route but /status, and reads once more when the answer is behind it", async () => {
  const asked: string[] = [];
  const answers: (number | null | "fail")[] = [];
  const fetcher = (async (input: unknown) => {
    asked.push(String(input));
    const checkpoint = answers.shift();
    if (checkpoint === "fail") throw new TypeError("offline");
    return Response.json({ provenance: { checkpoint: checkpoint ?? null } });
  }) as unknown as typeof fetch;
  const waits: number[] = [];
  const base = browserMarketDependencies(null, fetcher);
  assert.equal(atCheckpoint(base, null), base, "a poll's read is unchanged");
  const hinted = atCheckpoint(base, 40, async (ms) => {
    waits.push(ms);
  });
  const read = async (path: string) => ((await (await hinted.fetch(`${BROWSER_V1_ORIGIN}${path}`)).json()) as { provenance: { checkpoint: number | null } }).provenance.checkpoint;

  answers.push(40);
  assert.equal(await read("/v1/coins/0x1::a::A/holders?view=snapshot&limit=25"), 40);
  answers.push(41);
  assert.equal(await read("/v1/pools/blast_curve/0x2"), 41);
  answers.push(7);
  assert.equal(await read("/v1/status"), 7);
  assert.deepEqual(asked, [
    "/api/launchpad/market/coins/0x1::a::A/holders?view=snapshot&limit=25&at=40",
    "/api/launchpad/market/pools/blast_curve/0x2?at=40",
    "/api/launchpad/market/status",
  ]);
  assert.deepEqual(waits, [], "answers that reach the hint are taken as they are");

  asked.length = 0;
  answers.push(39, 40);
  assert.equal(await read("/v1/pools/blast_curve/0x2"), 40, "behind: read once more");
  answers.push(38, 39);
  assert.equal(await read("/v1/pools/blast_curve/0x2"), 39, "once only: the poll or the next hint does the rest");
  answers.push(null, "fail");
  assert.equal(await read("/v1/pools/blast_curve/0x2"), null, "a failed second read leaves the first answer");
  assert.equal(asked.length, 6);
  assert.deepEqual(waits, [BEHIND_RETRY_MS, BEHIND_RETRY_MS, BEHIND_RETRY_MS]);
});

test("the same hinted read asked twice while in flight is fetched once, and each reader gets its own answer", async () => {
  const asked: string[] = [];
  let release: (() => void) | null = null;
  const fetcher = (async (input: unknown) => {
    asked.push(String(input));
    await new Promise<void>((resolve) => { release = resolve; });
    return Response.json({ provenance: { checkpoint: 41 } });
  }) as unknown as typeof fetch;
  const base = browserMarketDependencies(null, fetcher);
  const flow = atCheckpoint(base, 41);
  const figures = atCheckpoint(base, 41);
  const path = `${BROWSER_V1_ORIGIN}/v1/pools/blast_curve/0x2`;
  const both = Promise.all([flow.fetch(path), figures.fetch(path)]);
  await new Promise((resolve) => setImmediate(resolve));
  release!();
  const [first, second] = await both;
  assert.deepEqual(asked, ["/api/launchpad/market/pools/blast_curve/0x2?at=41"]);
  assert.deepEqual([await first.json(), await second.json()], [{ provenance: { checkpoint: 41 } }, { provenance: { checkpoint: 41 } }]);
  const third = atCheckpoint(base, 41).fetch(path);
  await new Promise((resolve) => setImmediate(resolve));
  release!();
  await third;
  assert.equal(asked.length, 2, "a settled read is not kept: a later one fetches again (the CDN answers it)");
});
