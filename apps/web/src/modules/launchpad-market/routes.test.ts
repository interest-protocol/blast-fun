import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DEFAULT_RATE_POLICIES, LAUNCHPAD_MARKET_RATE_BUCKETS, type RateBucket, type RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { BLAST_INFRA_KEY_HEADER, blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";
import { encodeCursor } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { creatorClaimsCursor, walletHolderRewardsCursor, walletLaunchesCursor } from "@blast/core/modules/launchpad-contract/rewards.ts";
import {
  createMarketRoutes,
  MARKET_CACHE_CONTROL,
  MARKET_ROUTE_BUCKETS,
  SETTLED_CANDLES_CACHE_CONTROL,
  type MarketRouteName,
} from "@blast/server/modules/launchpad-market/routes.ts";
import { TEST_APP_ORIGIN, TEST_BLAST_INFRA_KEY, testMarketRoutes } from "../../../test/fixtures/modules/launchpad-market/testing.ts";
import { testClient } from "../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

const INFRA = "https://infra.blast.test";
const LAUNCH = `0x${"1".repeat(64)}`;
const POOL = `0x${"2".repeat(64)}`;
const COIN = `0x${"3".repeat(64)}::froggy::FROGGY`;
const WALLET = `0x${"4".repeat(64)}`;
const PARTNER = `0x${"5".repeat(64)}`;
const COMMITTED_MS = 1_790_000_000_000;
const PRIVATE = "private, no-store";
const POSITION = ["00000000000326274000", "00000000000000000001", "00000000000000000002"];
const WALLET_LAUNCHES_TOKEN = encodeCursor(walletLaunchesCursor(WALLET), [], POSITION);
const COMMITMENT = "7c".repeat(32);
const ACCOUNT_CLAIMS_TOKEN = encodeCursor(creatorClaimsCursor({ kind: "account", commitment: COMMITMENT }), [], POSITION);
/** A wallet's own reads and a recipient's creator claims: never stored on the CDN. */
const WALLET_ROUTES: ReadonlySet<MarketRouteName> = new Set(["wallet_launch_rewards", "wallet_holder_rewards", "wallet_launches", "creator_claims"]);

type Upstream = { status: number; body: string } | "unreachable";

/** blast-infra as a function of the path it is asked for; every request is recorded with its key header. */
function infra(
  answer: (path: string) => Upstream = () => ({ status: 200, body: JSON.stringify({ provenance: { timestamp_ms: COMMITTED_MS } }) }),
  expectedOrigin = INFRA,
) {
  const seen: { path: string; key: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, expectedOrigin);
    const path = `${url.pathname}${url.search}`;
    seen.push({ path, key: new Headers(init?.headers).get(BLAST_INFRA_KEY_HEADER) });
    const reply = answer(path);
    if (reply === "unreachable") throw new TypeError("fetch failed");
    return new Response(reply.body, { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { seen, fetcher };
}

/** A limiter that records each count and answers `allowed`. */
function limiter(allowed: boolean | "throws" = true) {
  const counted: { bucket: RateBucket; ip: string | undefined }[] = [];
  const port: RateLimitPort = {
    async consume(bucket, subject) {
      if (allowed === "throws") throw new Error("database unavailable");
      counted.push({ bucket, ip: subject.ip });
      return { allowed, bucket, policyVersion: 1, retryAfterSeconds: allowed ? 0 : 37 };
    },
  };
  return { counted, port };
}

function get(path: string): Request {
  return new Request(`${TEST_APP_ORIGIN}/api/launchpad/market${path}`);
}

const ROUTES: readonly [MarketRouteName, string, string][] = [
  ["candles", `/coins/${COIN}/candles?interval=1m&limit=2000`, `/v1/coins/${COIN}/candles?interval=1m&limit=2000`],
  ["coin", `/coins/${COIN}`, `/v1/coins/${COIN}`],
  ["holders", `/coins/${COIN}/holders?view=snapshot&limit=25`, `/v1/coins/${COIN}/holders?view=snapshot&limit=25`],
  ["activity", `/launches/${LAUNCH}/activity?view=classified&limit=25`, `/v1/launches/${LAUNCH}/activity?view=classified&limit=25`],
  ["pool", `/pools/blast_curve/${LAUNCH}`, `/v1/pools/blast_curve/${LAUNCH}`],
  ["pool", `/pools/cetus/${POOL}`, `/v1/pools/cetus/${POOL}`],
  ["candles", `/pools/blast_curve/${LAUNCH}/candles?interval=1m&limit=2000`, `/v1/pools/blast_curve/${LAUNCH}/candles?interval=1m&limit=2000`],
  ["trades", `/pools/blast_curve/${LAUNCH}/trades?limit=50`, `/v1/pools/blast_curve/${LAUNCH}/trades?limit=50`],
  ["trades", `/pools/bluefin/${POOL}/trades?limit=50&before=326274000:1:1:1`, `/v1/pools/bluefin/${POOL}/trades?limit=50&before=326274000%3A1%3A1%3A1`],
  ["status", "/status", "/v1/status"],
  ["rewards", `/launches/${LAUNCH}/rewards`, `/v1/launches/${LAUNCH}/rewards`],
  ["reward_rounds", `/launches/${LAUNCH}/reward-rounds?limit=10`, `/v1/launches/${LAUNCH}/reward-rounds?limit=10`],
  ["wallet_launch_rewards", `/wallets/${WALLET}/launch-rewards`, `/v1/wallets/${WALLET}/launch-rewards?limit=25`],
  ["wallet_holder_rewards", `/wallets/${WALLET}/launch-holder-rewards?limit=5`, `/v1/wallets/${WALLET}/vault-rewards?limit=5`],
  [
    "wallet_launches",
    `/wallets/${WALLET}/launches?limit=25&cursor=${WALLET_LAUNCHES_TOKEN}`,
    `/v1/wallets/${WALLET}/launches?limit=25&cursor=${WALLET_LAUNCHES_TOKEN}`,
  ],
  ["creator_claims", `/creator-claims?recipient=${WALLET}`, `/v1/creator-claims?recipient=${WALLET}&limit=25`],
  [
    "creator_claims",
    `/creator-claims?account=${COMMITMENT}&limit=10&cursor=${ACCOUNT_CLAIMS_TOKEN}`,
    `/v1/creator-claims?account=${COMMITMENT}&limit=10&cursor=${ACCOUNT_CLAIMS_TOKEN}`,
  ],
  ["partners", "/partners", "/v1/partners?limit=25"],
  ["partner", `/partners/${PARTNER}`, `/v1/partners/${PARTNER}`],
  ["partner_launches", `/partners/${PARTNER}/launches?limit=100`, `/v1/partners/${PARTNER}/launches?limit=100`],
  ["policy", "/launchpad/policy", "/v1/launchpad/policy"],
];

test("each route relays exactly its /v1 read with the key, counts in its own bucket per client IP, and is public on the CDN briefly unless it is a wallet's", async () => {
  for (const [route, path, upstream] of ROUTES) {
    const blast = infra();
    const counts = limiter();
    const routes = testMarketRoutes(INFRA, { fetch: blast.fetcher, limiter: counts.port });
    const response = await routes.handle(get(path), testClient());
    assert.equal(response.status, 200, route);
    assert.equal(await response.text(), JSON.stringify({ provenance: { timestamp_ms: COMMITTED_MS } }), `${route}: the body as blast-infra sent it`);
    assert.equal(response.headers.get("Cache-Control"), WALLET_ROUTES.has(route) ? PRIVATE : MARKET_CACHE_CONTROL, route);
    assert.equal(response.headers.get("Content-Type"), "application/json", route);
    assert.deepEqual(blast.seen, [{ path: upstream, key: TEST_BLAST_INFRA_KEY }], route);
    assert.deepEqual(counts.counted, [{ bucket: MARKET_ROUTE_BUCKETS[route], ip: "203.0.113.7" }], route);
  }
  assert.deepEqual(Object.values(MARKET_ROUTE_BUCKETS).sort(), [...LAUNCHPAD_MARKET_RATE_BUCKETS].sort());
  for (const bucket of LAUNCHPAD_MARKET_RATE_BUCKETS) assert.equal(DEFAULT_RATE_POLICIES[bucket].subjectScope, "ip", bucket);
});

test("complete reader selection preserves classified activity admission exactly once and refuses before transport when exhausted", async () => {
  for (const allowed of [true, false]) {
    const blast = infra(undefined, "https://reader.blast.test");
    const counts = limiter(allowed);
    const routes = createMarketRoutes({
      limiter: counts.port,
      upstream: () => ({ origin: INFRA, fetch: blastInfraFetch({ origin: INFRA, fetch: blast.fetcher, environment: {
        BLAST_INFRA_API_KEY: TEST_BLAST_INFRA_KEY,
        BLAST_INFRA_READ_ORIGIN: "https://reader.blast.test",
        BLAST_INFRA_READ_MODE: "committed-markets",
      } }) }),
    });
    const response = await routes.handle(get(`/launches/${LAUNCH}/activity?view=classified&limit=25`), testClient());
    assert.equal(response.status, allowed ? 200 : 429);
    assert.deepEqual(counts.counted, [{ bucket: MARKET_ROUTE_BUCKETS.activity, ip: "203.0.113.7" }]);
    assert.equal(blast.seen.length, allowed ? 1 : 0);
    if (allowed) assert.equal(blast.seen[0].path, `/v1/launches/${LAUNCH}/activity?view=classified&limit=25`);
  }
});

test("parameters are strict: only the page's query keys, once each, canonical IDs, bounded limits; nothing reaches blast-infra", async () => {
  const blast = infra();
  const routes = testMarketRoutes(INFRA, { fetch: blast.fetcher });
  for (const path of [
    `/coins/${COIN}/holders?view=snapshot&sort=balance`,
    `/coins/${COIN}/holders?view=snapshot&limit=1&limit=2`,
    `/coins/${COIN}/holders`,
    `/coins/${COIN}/holders?view=all`,
    `/coins/${COIN}/holders?view=snapshot&limit=101`,
    `/coins/${COIN}/holders?view=snapshot&limit=0`,
    `/coins/${COIN}/holders?view=snapshot&limit=1e2`,
    `/coins/${COIN}/holders?view=snapshot&cursor=a.b`,
    `/coins/0xabc::froggy::FROGGY/holders?view=snapshot`,
    `/coins/${COIN}<T>/holders?view=snapshot`,
    `/launches/0x1/activity?view=classified`,
    `/launches/${LAUNCH}/activity?view=classified&cursor=not-a-token`,
    `/launches/${LAUNCH}/activity?view=raw`,
    `/launches/${LAUNCH}/activity?view=classified&wallet_labels=unknown`,
    `/launches/${LAUNCH}/activity?view=classified&limit=101`,
    `/pools/blast_curve/0x1`,
    `/coins/${COIN}?view=summary`,
    `/coins/0xabc::froggy::FROGGY`,
    `/pools/blast_curve/${LAUNCH}?fields=all`,
    `/pools/blast_curve/${LAUNCH}/candles?interval=2m`,
    `/pools/blast_curve/${LAUNCH}/candles?interval=1m&from=10&to=5`,
    `/pools/blast_curve/${LAUNCH}/candles?interval=1m&from=-1`,
    `/pools/blast_curve/${LAUNCH}/candles?interval=1m&limit=2001`,
    `/pools/uniswap/${POOL}/candles?interval=1m`,
    `/pools/bluefin/${POOL}/trades?before=1:2:3`,
    `/pools/bluefin/${POOL}/trades?limit=201`,
    `/pools/bluefin/${POOL}/trades?cursor=x`,
    `/status?verbose=1`,
    `/launches/${LAUNCH}/rewards?limit=1`,
    `/launches/0x1/rewards`,
    `/launches/${LAUNCH}/reward-rounds?limit=101`,
    `/launches/${LAUNCH}/reward-rounds?cursor=${WALLET_LAUNCHES_TOKEN}`,
    `/wallets/0x1/launches`,
    `/wallets/0x${"A".repeat(64)}/launches`,
    `/wallets/${WALLET}/launches?sort=new`,
    `/wallets/${WALLET}/launch-rewards?limit=0`,
    `/wallets/${WALLET}/launch-rewards?cursor=${WALLET_LAUNCHES_TOKEN}`,
    `/wallets/${WALLET}/launch-holder-rewards?cursor=${encodeCursor(walletHolderRewardsCursor(PARTNER), [], POSITION)}`,
    `/partners?limit=1&limit=2`,
    `/partners?cursor=not-a-token`,
    `/partners/0x5`,
    `/partners/${PARTNER}?verbose=1`,
    `/partners/${PARTNER}/launches?cursor=${WALLET_LAUNCHES_TOKEN}`,
    `/launchpad/policy?since=1`,
    // LP-17: exactly one recipient, canonical, and a token of that recipient's own list.
    `/creator-claims`,
    `/creator-claims?limit=5`,
    `/creator-claims?recipient=${WALLET}&account=${COMMITMENT}`,
    `/creator-claims?recipient=${WALLET}&recipient=${WALLET}`,
    `/creator-claims?recipient=0x1`,
    `/creator-claims?recipient=0x${"A".repeat(64)}`,
    `/creator-claims?account=0x${COMMITMENT}`,
    `/creator-claims?account=${COMMITMENT.toUpperCase()}`,
    `/creator-claims?account=${COMMITMENT}0`,
    `/creator-claims?account=${COMMITMENT}&sort=new`,
    `/creator-claims?account=${COMMITMENT}&limit=101`,
    `/creator-claims?recipient=${WALLET}&cursor=${ACCOUNT_CLAIMS_TOKEN}`,
    `/creator-claims?account=${"7d".repeat(32)}&cursor=${ACCOUNT_CLAIMS_TOKEN}`,
  ]) {
    const response = await routes.handle(get(path), testClient());
    assert.equal(response.status, 400, path);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_parameter", path);
    assert.equal(response.headers.get("Cache-Control"), PRIVATE, path);
  }
  for (const path of [
    `/pools/uniswap/${POOL}`,
    `/pools/uniswap/${POOL}/trades`,
    `/pools/bluefin/${POOL}/holders`,
    `/coins/${COIN}/pools`,
    `/launches/${LAUNCH}`,
    `/launches/${LAUNCH}/opening-round/bidders`,
    `/presales`,
    `/status/`,
    `/ws`,
    `/wallets/${WALLET}`,
    `/wallets/${WALLET}/trades`,
    `/wallets/${WALLET}/launches/more`,
    `/partners/`,
    `/partners/${PARTNER}/earnings`,
    `/launchpad`,
    `/launchpad/policy/now`,
    `/creator-claims/${WALLET}`,
  ]) {
    const response = await routes.handle(get(path), testClient());
    assert.equal(response.status, 404, path);
  }
  assert.deepEqual(blast.seen, []);
});

test("a full bucket is 429 with Retry-After and reads nothing; a limiter that cannot count is 503", async () => {
  const blast = infra();
  const refused = await testMarketRoutes(INFRA, { fetch: blast.fetcher, limiter: limiter(false).port }).handle(get("/status"), testClient());
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "37");
  assert.equal(refused.headers.get("Cache-Control"), PRIVATE);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "rate_limited");
  const broken = await testMarketRoutes(INFRA, { fetch: blast.fetcher, limiter: limiter("throws").port }).handle(get("/status"), testClient());
  assert.equal(broken.status, 503);
  assert.equal(broken.headers.get("Retry-After"), "5");
  assert.deepEqual(blast.seen, []);
  // A malformed request still counts: a scanner pays for every probe.
  const counts = limiter();
  await testMarketRoutes(INFRA, { fetch: blast.fetcher, limiter: counts.port }).handle(get("/status?x=1"), testClient());
  assert.equal(counts.counted.length, 1);
});

test("each launchpad rewards, wallet, partner and policy route refuses when its own bucket is full and relays an upstream failure in fixed words", async () => {
  for (const [route, path] of ROUTES.filter(([name]) => !["holders", "activity", "pool", "candles", "trades", "status"].includes(name))) {
    const full = limiter(false);
    const blast = infra();
    const refused = await testMarketRoutes(INFRA, { fetch: blast.fetcher, limiter: full.port }).handle(get(path), testClient());
    assert.equal(refused.status, 429, route);
    assert.equal(refused.headers.get("Retry-After"), "37", route);
    assert.deepEqual(blast.seen, [], `${route}: a full bucket reads nothing`);

    const failing = infra(() => ({ status: 503, body: JSON.stringify({ error: { code: "not_ready", message: "the launchpad is not configured" } }) }));
    const failed = await testMarketRoutes(INFRA, { fetch: failing.fetcher }).handle(get(path), testClient());
    assert.equal(failed.status, 503, route);
    const text = await failed.text();
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, "unavailable", route);
    assert.doesNotMatch(text, /launchpad is not configured/, `${route}: never the upstream's words`);
    assert.equal(failed.headers.get("Cache-Control"), PRIVATE, route);

    const unreachable = await testMarketRoutes(INFRA, { fetch: infra(() => "unreachable").fetcher }).handle(get(path), testClient());
    assert.equal(unreachable.status, 502, route);
  }
});

test("a candle page that ends at or before blast-infra's committed checkpoint is settled and kept longer; an open one is not", async () => {
  const blast = infra();
  const routes = testMarketRoutes(INFRA, { fetch: blast.fetcher });
  const candles = (query: string) => routes.handle(get(`/pools/blast_curve/${LAUNCH}/candles?${query}`), testClient());
  assert.equal((await candles(`interval=1h&from=1&to=${COMMITTED_MS}`)).headers.get("Cache-Control"), SETTLED_CANDLES_CACHE_CONTROL);
  assert.equal((await candles(`interval=1h&to=${COMMITTED_MS - 3_600_000}`)).headers.get("Cache-Control"), SETTLED_CANDLES_CACHE_CONTROL);
  assert.equal((await candles(`interval=1h&to=${COMMITTED_MS + 1}`)).headers.get("Cache-Control"), MARKET_CACHE_CONTROL, "past the checkpoint: still open");
  assert.equal((await candles("interval=1h&from=1")).headers.get("Cache-Control"), MARKET_CACHE_CONTROL, "no end: runs to now");
  const noCheckpoint = testMarketRoutes(INFRA, { fetch: infra(() => ({ status: 200, body: JSON.stringify({ provenance: { timestamp_ms: null } }) })).fetcher });
  assert.equal(
    (await noCheckpoint.handle(get(`/pools/blast_curve/${LAUNCH}/candles?interval=1h&to=1`), testClient())).headers.get("Cache-Control"),
    MARKET_CACHE_CONTROL,
  );
});

test("a hinted read (at) relays the route's own read without at; its 200 is public only when the body reaches at", async () => {
  const answering = (checkpoint: number | null) => infra(() => ({ status: 200, body: JSON.stringify({ provenance: { checkpoint, timestamp_ms: COMMITTED_MS } }) }));
  for (const [route, path, upstream] of ROUTES) {
    if (route === "status") continue;
    const hinted = `${path}${path.includes("?") ? "&" : "?"}at=326274009`;
    // A wallet's reads are never public, whatever at says.
    const reached = WALLET_ROUTES.has(route) ? PRIVATE : MARKET_CACHE_CONTROL;
    for (const [checkpoint, cache] of [[326274009, reached], [326274010, reached], [326274008, PRIVATE], [null, PRIVATE]] as const) {
      const blast = answering(checkpoint);
      const response = await testMarketRoutes(INFRA, { fetch: blast.fetcher }).handle(get(hinted), testClient());
      assert.equal(response.status, 200, `${route} at ${checkpoint}`);
      assert.equal(response.headers.get("Cache-Control"), cache, `${route}: answered at ${checkpoint}`);
      assert.deepEqual(blast.seen.map((seen) => seen.path), [upstream], `${route}: at never reaches blast-infra`);
    }
  }
  const settled = answering(326274009);
  const candles = await testMarketRoutes(INFRA, { fetch: settled.fetcher }).handle(get(`/pools/blast_curve/${LAUNCH}/candles?interval=1h&to=${COMMITTED_MS}&at=326274009`), testClient());
  assert.equal(candles.headers.get("Cache-Control"), SETTLED_CANDLES_CACHE_CONTROL, "the route's own rule once at is reached");
  const blast = answering(1);
  const routes = testMarketRoutes(INFRA, { fetch: blast.fetcher });
  for (const path of [
    "/status?at=1",
    `/coins/${COIN}/holders?view=snapshot&at=1&at=2`,
    `/coins/${COIN}/holders?view=snapshot&at=01`,
    `/coins/${COIN}/holders?view=snapshot&at=-1`,
    `/coins/${COIN}/holders?view=snapshot&at=1.5`,
    `/coins/${COIN}/holders?view=snapshot&at=`,
    `/coins/${COIN}/holders?view=snapshot&at=12345678901234567`,
    `/coins/${COIN}/holders?view=all&at=1`,
  ]) {
    const response = await routes.handle(get(path), testClient());
    assert.equal(response.status, 400, path);
    assert.equal(response.headers.get("Cache-Control"), PRIVATE, path);
  }
  assert.equal((await routes.handle(get(`/pools/uniswap/${POOL}?at=1`), testClient())).status, 404);
  assert.deepEqual(blast.seen, []);
});

test("upstream refusals use fixed local messages and never expose provider details", async () => {
  const replies: Record<string, Upstream> = {
    "/v1/status": { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "no such coin" } }) },
  };
  const answer = (status: number, body: string) => testMarketRoutes(INFRA, { fetch: infra(() => ({ status, body })).fetcher }).handle(get("/status"), testClient());

  const notFound = await testMarketRoutes(INFRA, { fetch: infra((path) => replies[path]!).fetcher }).handle(get("/status"), testClient());
  assert.equal(notFound.status, 404);
  assert.deepEqual(await notFound.json(), { error: { code: "not_found", message: "Market data was not found." } });
  assert.equal(notFound.headers.get("Cache-Control"), PRIVATE);

  const starting = await answer(503, JSON.stringify({ error: { code: "not_ready", message: "the engine has not bootstrapped" } }));
  assert.equal(starting.status, 503);
  assert.equal(((await starting.json()) as { error: { code: string } }).error.code, "unavailable");
  assert.equal(starting.headers.get("Cache-Control"), PRIVATE);

  for (const [status, body, code] of [
    [401, JSON.stringify({ error: { code: "unauthorized", message: "bad key abc" } }), "unavailable"],
    [403, "forbidden", "unavailable"],
    [502, "<html>bad gateway</html>", "bad_gateway"],
    [200, "not json", "bad_gateway"],
  ] as const) {
    const response = await answer(status, body);
    assert.equal(response.status, 502, `${status} ${body}`);
    const text = await response.text();
    assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, code);
    assert.doesNotMatch(text, /abc|html|forbidden|not json/, "never the upstream's words");
    assert.equal(response.headers.get("Cache-Control"), PRIVATE);
  }

  const unreachable = await testMarketRoutes(INFRA, { fetch: infra(() => "unreachable").fetcher }).handle(get("/status"), testClient());
  assert.equal(unreachable.status, 502);
  assert.equal(((await unreachable.json()) as { error: { code: string } }).error.code, "unreachable");

  const unconfigured = await createMarketRoutes({
    limiter: null,
    upstream: () => {
      throw new Error("BLAST_INFRA_ORIGIN is required for market reads.");
    },
  }).handle(get("/status"), testClient());
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { error: { code: "unconfigured", message: "Market data is not configured here." } });
});

test("without a configured key the request carries none; the key never appears in an answer", async () => {
  const blast = infra(() => ({ status: 200, body: JSON.stringify({ ok: true }) }));
  await testMarketRoutes(INFRA, { fetch: blast.fetcher, apiKey: null }).handle(get("/status"), testClient());
  assert.deepEqual(blast.seen, [{ path: "/v1/status", key: null }]);
  const keyed = await testMarketRoutes(INFRA, { fetch: blast.fetcher }).handle(get("/status"), testClient());
  assert.doesNotMatch(JSON.stringify([...keyed.headers]) + (await keyed.text()), new RegExp(TEST_BLAST_INFRA_KEY));
});

test("review L13: /status relays the engine's status without engine_id (its host name); every other field and route is untouched", async () => {
  const status = { provenance: { timestamp_ms: COMMITTED_MS }, checkpoint: 7, lag_ms: 3, cursor: null, engine_id: "ip-10-0-0-12.internal" };
  const routes = testMarketRoutes(INFRA, { fetch: infra(() => ({ status: 200, body: JSON.stringify(status) })).fetcher });
  const answer = await routes.handle(get("/status"), testClient());
  assert.equal(answer.status, 200);
  const text = await answer.text();
  assert.doesNotMatch(text, /engine_id|ip-10-0-0-12/);
  assert.deepEqual(JSON.parse(text), { provenance: { timestamp_ms: COMMITTED_MS }, checkpoint: 7, lag_ms: 3, cursor: null });
  // Another route's body is relayed byte for byte, even with a field of that name.
  const pool = testMarketRoutes(INFRA, { fetch: infra(() => ({ status: 200, body: JSON.stringify(status) })).fetcher });
  const relayed = await pool.handle(get(`/pools/blast_curve/${LAUNCH}`), testClient());
  assert.deepEqual(await relayed.json(), status);
});

test("#575: /status relays exactly the published MarketStatus fields from the writer and from a committed reader", async () => {
  const contract = JSON.parse(readFileSync(new URL("../../../scripts/partner-api-live/contract.json", import.meta.url), "utf8"));
  const schema = contract.components.schemas.MarketStatus as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
  assert.equal(schema.additionalProperties, false);
  const provenance = { network: "mainnet", deployment_fingerprint: "f".repeat(64), checkpoint: 7, timestamp_ms: COMMITTED_MS, observed_ms: COMMITTED_MS + 3, lag_ms: 3 };
  const published = { provenance, checkpoint: 7, timestamp_ms: COMMITTED_MS, lag_ms: 3, cursor: "7:1:2:0" };
  const writer = { ...published, engine_id: "blast-infra" };
  const reader = {
    status: "ok", ...published, engine_id: "reader:7:1", role: "reader", database_role: "primary",
    replay_paused: false, replay_timestamp_ms: null, read_models: "committed_sql_v1", serveable: true,
  };
  for (const upstream of [writer, reader]) {
    const routes = testMarketRoutes(INFRA, { fetch: infra(() => ({ status: 200, body: JSON.stringify(upstream) })).fetcher });
    const answer = await routes.handle(get("/status"), testClient());
    assert.equal(answer.status, 200);
    const relayed = await answer.json() as Record<string, unknown>;
    assert.deepEqual(relayed, published, upstream.engine_id);
    assert.deepEqual(Object.keys(relayed).sort(), [...schema.required].sort());
    assert.deepEqual(Object.keys(schema.properties).sort(), [...schema.required].sort());
  }
});

test("market failures never expose upstream secrets and provide a support reference", async () => {
  const routes = testMarketRoutes(INFRA, { fetch: infra(() => ({
    status: 503,
    body: JSON.stringify({ error: { code: "database_failed", message: "Bearer private-key SELECT private_table" } }),
  })).fetcher });
  const response = await routes.handle(get("/status"), testClient());
  assert.equal(response.status, 503);
  assert.ok(response.headers.get("x-request-id"));
  const text = await response.text();
  assert.match(text, /"code":"unavailable"/);
  assert.doesNotMatch(text, /private-key|private_table|database_failed/);
});
