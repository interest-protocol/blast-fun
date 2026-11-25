import assert from "node:assert/strict";
import test from "node:test";
import { cachedMarketUpstream } from "@blast/server/modules/launchpad-market/public-cache.ts";
import { createMarketRoutes } from "@blast/server/modules/launchpad-market/routes.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";

const origin = "https://synthetic.invalid";

test("market routes use bounded cached text without constructing and re-reading an intermediate Response", async () => {
  let reads = 0;
  const shared = cachedMarketUpstream({ origin, fetch: async () => Response.json({ reads: ++reads }) }, createPublicPresaleReader());
  const routes = createMarketRoutes({
    limiter: null,
    upstream: () => ({
      ...shared,
      fetch: () => assert.fail("The route should use the already-bounded text path"),
    }),
  });
  for (let i = 0; i < 2; i++) {
    const response = await routes.handle(new Request(`https://blast.test/api/launchpad/market/pools/blast_curve/0x${"a".repeat(64)}`), testClient());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reads: 1 });
  }
  assert.equal(reads, 1);
});

test("market data coalesces across callers for five seconds while status stays fresh", async () => {
  let now = 0;
  let sourceReads = 0;
  const upstream = cachedMarketUpstream({ origin, fetch: async () => {
    sourceReads++;
    return Response.json({ sourceRead: sourceReads });
  } }, createPublicPresaleReader(() => now));
  const path = `${origin}/v1/pools/blast_curve/fixture/candles?interval=1m`;
  const replies = await Promise.all(Array.from({ length: 100 }, () => upstream.fetch(path)));
  assert.equal(sourceReads, 1);
  for (const reply of replies) assert.deepEqual(await reply.json(), { sourceRead: 1 });
  now = 5_000;
  assert.deepEqual(await (await upstream.fetch(path)).json(), { sourceRead: 2 });
  for (let i = 0; i < 2; i++) await upstream.fetch(`${origin}/v1/status`);
  assert.equal(sourceReads, 4, "Status must not hide changes in readiness/lag");
});

test("market errors and malformed success bodies are never cached", async () => {
  for (const status of [401, 404, 429, 503, 200]) {
    let reads = 0;
    const upstream = cachedMarketUpstream({ origin, fetch: async () => {
      reads++;
      return new Response("invalid provider body", { status });
    } }, createPublicPresaleReader());
    for (let i = 0; i < 2; i++) {
      const response = await upstream.fetch(`${origin}/v1/pools/fixture`);
      assert.equal(response.status, status);
      if (status !== 200) assert.doesNotMatch(response.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(await response.text(), "invalid provider body");
    }
    assert.equal(reads, 2);
  }
});

test("market cache isolates query pages and origin and never retains mutations", async () => {
  let reads = 0;
  const upstream = cachedMarketUpstream({ origin, fetch: async () => Response.json({ read: ++reads }) }, createPublicPresaleReader());
  const one = `${origin}/v1/pools/fixture/trades?limit=1`;
  await upstream.fetch(one);
  await upstream.fetch(`${one}0`);
  await upstream.fetch(one);
  assert.equal(reads, 2);
  for (let i = 0; i < 2; i++) await upstream.fetch("https://other.invalid/v1/pools/fixture");
  for (let i = 0; i < 2; i++) await upstream.fetch(one, { method: "POST" });
  assert.equal(reads, 6);
});

test("coalesced failures retain independent response bodies and a fresh retry recovers", async () => {
  let reads = 0;
  const upstream = cachedMarketUpstream({ origin, fetch: async () => {
    reads++;
    return reads === 1 ? new Response("synthetic unavailable", { status: 503 }) : Response.json({ recovered: true });
  } }, createPublicPresaleReader());
  const path = `${origin}/v1/pools/fixture/trades`;
  const replies = await Promise.all(Array.from({ length: 20 }, () => upstream.fetch(path)));
  for (const reply of replies) {
    assert.equal(reply.status, 503);
    assert.equal(await reply.text(), "synthetic unavailable");
  }
  assert.equal(reads, 1);
  assert.deepEqual(await (await upstream.fetch(path)).json(), { recovered: true });
  assert.equal(reads, 2);
});

test("separate server bundles share uncached responses without turning them into errors", async () => {
  const otherBundle = await import(new URL("./public-cache.ts?other-bundle", import.meta.url).href) as typeof import("@blast/server/modules/launchpad-market/public-cache.ts");
  for (const [status, text] of [
    [503, "synthetic unavailable"],
    [200, JSON.stringify({ value: "x".repeat(256 * 1_024) })],
  ] as const) {
    let reads = 0;
    const publicRead = createPublicPresaleReader();
    const source = { origin, fetch: async () => {
      reads++;
      return reads === 1 ? new Response(text, { status }) : Response.json({ recovered: true });
    } };
    const bundles = [cachedMarketUpstream(source, publicRead), otherBundle.cachedMarketUpstream(source, publicRead)];
    const path = `${origin}/v1/pools/fixture/trades`;
    const replies = await Promise.all(bundles.map((bundle) => bundle.fetch(path)));
    assert.equal(reads, 1);
    for (const reply of replies) {
      assert.equal(reply.status, status);
      assert.equal(await reply.text(), text);
    }
    assert.deepEqual(await (await bundles[1].fetch(path)).json(), { recovered: true });
    assert.equal(reads, 2, "Uncacheable responses must not prevent a fresh retry");
  }
});

test("large successful bodies bypass retention and oversized streams are cancelled", { timeout: 1_000 }, async () => {
  const large = JSON.stringify({ value: "x".repeat(256 * 1_024) });
  let reads = 0;
  const upstream = cachedMarketUpstream({ origin, fetch: async () => {
    reads++;
    return new Response(large);
  } }, createPublicPresaleReader());
  for (let i = 0; i < 2; i++) assert.equal(await (await upstream.fetch(`${origin}/v1/pools/fixture`)).text(), large);
  assert.equal(reads, 2);

  for (const status of [200, 503]) {
    let cancelled = false;
    const oversized = cachedMarketUpstream({ origin, fetch: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }), { status }) }, createPublicPresaleReader());
    await assert.rejects(oversized.fetch(`${origin}/v1/pools/fixture`), /read limit/);
    assert.equal(cancelled, true);
  }
});

test("a hint's read past the shared answer reads blast-infra again, once per checkpoint", async () => {
  let checkpoint = 4;
  let reads = 0;
  const shared = cachedMarketUpstream({ origin, fetch: async () => {
    reads++;
    return Response.json({ provenance: { checkpoint } });
  } }, createPublicPresaleReader(() => 0));
  const routes = createMarketRoutes({ limiter: null, upstream: () => shared });
  const candles = `https://blast.test/api/launchpad/market/pools/blast_curve/0x${"a".repeat(64)}/candles?interval=1m`;
  const read = async (url: string) => {
    const response = await routes.handle(new Request(url), testClient());
    return { checkpoint: ((await response.json()) as { provenance: { checkpoint: number } }).provenance.checkpoint, cache: response.headers.get("cache-control") };
  };
  assert.equal((await read(candles)).checkpoint, 4);
  checkpoint = 6;
  assert.equal((await read(`${candles}&at=4`)).checkpoint, 4, "the shared answer already reaches the hint");
  assert.equal(reads, 1);
  const hinted = await Promise.all([read(`${candles}&at=5`), read(`${candles}&at=5`)]);
  assert.deepEqual(hinted.map((reply) => reply.checkpoint), [6, 6], "an older shared answer is read again");
  assert.match(hinted[0].cache ?? "", /^public/);
  assert.equal(reads, 2, "viewers of one hint share that read");
});
