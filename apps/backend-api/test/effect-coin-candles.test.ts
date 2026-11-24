import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  parseCoinCandlePage,
  parsePoolCandlePage,
} from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import type { Venue } from "@blast/core/modules/launchpad-contract/venues.ts";
import {
  createAdmittedMarketRead,
  createMarketRoutes,
  MARKET_CACHE_CONTROL,
  type MarketUpstream,
  SETTLED_CANDLES_CACHE_CONTROL,
} from "@blast/server/modules/launchpad-market/routes.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import type { PartnerGrant } from "@blast/server/modules/partner-api-keys/contracts.ts";
import { PartnerRecognitionStore } from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import type { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import { createBackendRelay } from "../../web/src/modules/partner-api/v1/relay.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { marketSourceBucket } from "@blast/server/modules/partner-api/v1/paths.ts";
import { createEffectHttp } from "../src/app/api/effect-http.ts";
import { createBackendServer } from "../src/app/server.ts";
import { capacityFixture } from "./capacity-fixture.ts";

const NAMESPACE = "a".repeat(64);
const SECRET = "s".repeat(32);
const PEPPER = "p".repeat(32);
const ORIGIN = "https://partner.example";
const KEY = `blast_pk_${"a".repeat(43)}`;
const GRANT: PartnerGrant = {
  id: "acme",
  keyId: "11111111-1111-4111-8111-111111111111",
  origins: [ORIGIN],
  policy: { tier: "standard" },
};
const COIN = `0x${"3".repeat(64)}::froggy::FROGGY`;
const LONG_COIN = `0x${"3".repeat(64)}::${"M".repeat(128)}::${"T".repeat(128)}`;
const CURVE = { venue: "blast_curve", id: `0x${"4".repeat(64)}` } as const;
const CETUS = { venue: "cetus", id: `0x${"5".repeat(64)}` } as const;
const BLUEFIN = { venue: "bluefin", id: `0x${"6".repeat(64)}` } as const;
const CANDLE_PAGE = {
  interval: "1m",
  candles: [
    {
      bucket_start: 0,
      interval: "1m",
      open: "1",
      high: "1",
      low: "1",
      close: "1",
      volume_quote: "9007199254740993",
      volume_meme: "2",
      volume_usd: null,
      buys: 1,
      sells: 0,
      trades: 1,
    },
  ],
  migration: null,
  provenance: {
    network: "mainnet",
    deployment_fingerprint: "f".repeat(64),
    checkpoint: 100,
    timestamp_ms: 120_000,
    observed_ms: 121_000,
    lag_ms: 1_000,
  },
};
const CANDLE_BODY = JSON.stringify(CANDLE_PAGE, null, 2);
const STATUS = {
  checkpoint: 100,
  timestamp_ms: 120_000,
  lag_ms: 1_000,
  cursor: "100:1:2:0",
  provenance: CANDLE_PAGE.provenance,
};

type CandleCase = Readonly<{
  name: string;
  query: string;
  status: number;
  cache?: string;
  method?: string;
  coinType?: string;
  pool?: Readonly<{ venue: Venue; id: string }>;
  statusRead?: true;
  wire?: string;
  upstreamStatus?: number;
  read?: Readonly<{ public: string; upstream: string; firstParty?: string }>;
}>;

const LIVE_CASE = {
  name: "live",
  query: "interval=1m",
  wire: "interval=1m&limit=500",
  status: 200,
  cache: MARKET_CACHE_CONTROL,
} satisfies CandleCase;

const SETTLED_CASE = {
  name: "settled",
  query: "interval=1m&limit=01&to=60000&at=100",
  wire: "interval=1m&limit=1&to=60000",
  status: 200,
  cache: SETTLED_CANDLES_CACHE_CONTROL,
} satisfies CandleCase;

const LAGGING_CASE = {
  name: "reader behind the hint",
  query: "interval=1m&at=101",
  wire: "interval=1m&limit=500",
  status: 200,
  cache: "private, no-store",
} satisfies CandleCase;

const HEAD_CASE = {
  name: "HEAD",
  method: "HEAD",
  query: "interval=1m",
  wire: "interval=1m&limit=500",
  status: 200,
  cache: MARKET_CACHE_CONTROL,
} satisfies CandleCase;

const THROTTLED_CASE = {
  name: "quota refused before validation",
  query: "interval=invalid",
  status: 429,
  cache: "no-store",
} satisfies CandleCase;

const CASES: readonly CandleCase[] = [
  LIVE_CASE,
  {
    name: "longest canonical coin type",
    coinType: LONG_COIN,
    query: "interval=1m",
    wire: "interval=1m&limit=500",
    status: 200,
    cache: MARKET_CACHE_CONTROL,
  },
  {
    name: "coin type at the route limit with an invalid identifier",
    coinType: "a".repeat(512),
    query: "interval=1m",
    status: 400,
  },
  SETTLED_CASE,
  LAGGING_CASE,
  HEAD_CASE,
  { name: "unknown query key", query: "interval=1m&extra=1", status: 400 },
  { name: "reserved query key", query: "interval=1m&__proto__=1", status: 400 },
  { name: "repeated interval", query: "interval=1m&%69nterval=1h", status: 400 },
  { name: "repeated hint", query: "interval=1m&at=100&at=101", status: 400 },
  { name: "missing interval", query: "limit=1", status: 400 },
  { name: "reversed bounds", query: "interval=1m&from=60000&to=1", status: 400 },
  { name: "invalid limit", query: "interval=1m&limit=0", status: 400 },
  {
    name: "upstream missing",
    query: "interval=1m",
    wire: "interval=1m&limit=500",
    upstreamStatus: 404,
    status: 404,
  },
  {
    name: "upstream key rejected",
    query: "interval=1m",
    wire: "interval=1m&limit=500",
    upstreamStatus: 401,
    status: 502,
  },
  { name: "upstream unconfigured", query: "interval=1m", status: 503 },
  THROTTLED_CASE,
];

test("the Effect candle endpoint preserves browser and partner HTTP behavior and quota", async () => {
  assert.deepEqual(await exercise(true, CASES), await exercise(false, CASES));
});

test("Effect pool candles preserve migration data, cache behavior, and quota for both callers", async () => {
  const poolCases = [
    { ...LIVE_CASE, pool: CURVE },
    { ...SETTLED_CASE, pool: CETUS },
    { ...LAGGING_CASE, pool: BLUEFIN },
    { ...HEAD_CASE, pool: CETUS },
    { name: "repeated interval", pool: CURVE, query: "interval=1m&%69nterval=1h", status: 400 },
    { name: "reversed bounds", pool: CETUS, query: "interval=1m&from=60000&to=1", status: 400 },
    { ...THROTTLED_CASE, pool: BLUEFIN },
  ];
  assert.deepEqual(await exercise(true, poolCases), await exercise(false, poolCases));
});

test("Effect market status preserves the partner and browser contract", async () => {
  const cases = [
    { ...LIVE_CASE, query: "", wire: "" },
    { ...HEAD_CASE, query: "&", wire: "" },
    { name: "unknown key", query: "at=100", status: 400 },
    { name: "reserved key", query: "__proto__=1", status: 400 },
    { name: "repeated encoded key", query: "at=100&%61t=101", status: 400 },
    { name: "empty key", query: "=1", status: 400 },
    { name: "upstream refused", query: "", wire: "", status: 502, upstreamStatus: 401 },
    { name: "upstream unconfigured", query: "", status: 503 },
    THROTTLED_CASE,
  ].map((example) => ({ ...example, statusRead: true }) as const);
  assert.deepEqual(await exercise(true, cases), await exercise(false, cases));
});

test("the Effect holder and wallet reads preserve the browser and partner wire contracts", async () => {
  const cases = [
    {
      ...LIVE_CASE,
      query: "view=snapshot&limit=01&at=100&cursor=page_1",
      wire: "view=snapshot&limit=1&cursor=page_1",
      read: {
        public: `coins/${encodeURIComponent(COIN)}/holders`,
        upstream: `coins/${COIN}/holders`,
      },
    },
    {
      ...HEAD_CASE,
      query: "at=100",
      wire: "limit=25",
      cache: "private, no-store",
      read: {
        public: `wallets/${CURVE.id}/launch-holder-rewards`,
        firstParty: `wallets/${CURVE.id}/vault-rewards`,
        upstream: `wallets/${CURVE.id}/vault-rewards`,
      },
    },
  ];
  assert.deepEqual(await exercise(true, cases), await exercise(false, cases));
});

const MARKET_READS = [
  [
    `coins/${encodeURIComponent(COIN)}?at=100`,
    `coins/${COIN}`,
    "launchpad_market_coin",
    MARKET_CACHE_CONTROL,
  ],
  [
    `coins/${encodeURIComponent(COIN)}/holders?view=snapshot&cursor=abc_123`,
    `coins/${COIN}/holders?view=snapshot&limit=25&cursor=abc_123`,
    "launchpad_market_holders",
    MARKET_CACHE_CONTROL,
  ],
  [
    `launches/${CURVE.id}/activity?view=classified&wallet_labels=true&limit=00001`,
    `launches/${CURVE.id}/activity?view=classified&limit=1&wallet_labels=true`,
    "launchpad_market_activity",
    MARKET_CACHE_CONTROL,
  ],
  [
    `pools/blast_curve/${CURVE.id}?at=101`,
    `pools/blast_curve/${CURVE.id}`,
    "launchpad_market_pool",
    "private, no-store",
  ],
  [
    `pools/cetus/${CETUS.id}/trades?before=1:2:3:0`,
    `pools/cetus/${CETUS.id}/trades?limit=50&before=1%3A2%3A3%3A0`,
    "launchpad_market_trades",
    MARKET_CACHE_CONTROL,
  ],
  [
    `launches/${CURVE.id}/rewards`,
    `launches/${CURVE.id}/rewards`,
    "launchpad_market_rewards",
    MARKET_CACHE_CONTROL,
  ],
  [
    `launches/${CURVE.id}/reward-rounds?limit=2`,
    `launches/${CURVE.id}/reward-rounds?limit=2`,
    "launchpad_market_reward_rounds",
    MARKET_CACHE_CONTROL,
  ],
  [
    `wallets/${CURVE.id}/launches`,
    `wallets/${CURVE.id}/launches?limit=25`,
    "launchpad_market_wallet_launches",
    "private, no-store",
  ],
  [
    `wallets/${CURVE.id}/launch-rewards`,
    `wallets/${CURVE.id}/launch-rewards?limit=25`,
    "launchpad_market_wallet_launch_rewards",
    "private, no-store",
  ],
  [
    `wallets/${CURVE.id}/launch-holder-rewards`,
    `wallets/${CURVE.id}/vault-rewards?limit=25`,
    "launchpad_market_wallet_holder_rewards",
    "private, no-store",
  ],
  [
    `creator-claims?recipient=${CURVE.id}`,
    `creator-claims?recipient=${CURVE.id}&limit=25`,
    "launchpad_market_creator_claims",
    "private, no-store",
  ],
  [
    `creator-claims?account=${"f".repeat(64)}`,
    `creator-claims?account=${"f".repeat(64)}&limit=25`,
    "launchpad_market_creator_claims",
    "private, no-store",
  ],
  ["partners", "partners?limit=25", "launchpad_market_partners", MARKET_CACHE_CONTROL],
  [
    `partners/${CURVE.id}`,
    `partners/${CURVE.id}`,
    "launchpad_market_partner",
    MARKET_CACHE_CONTROL,
  ],
  [
    `partners/${CURVE.id}/launches`,
    `partners/${CURVE.id}/launches?limit=25`,
    "launchpad_market_partner_launches",
    MARKET_CACHE_CONTROL,
  ],
  [
    "launchpad/policy?&&%61t=%31%30%30&",
    "launchpad/policy",
    "launchpad_market_policy",
    MARKET_CACHE_CONTROL,
  ],
] as const;

for (const [path, upstreamPath, bucket, cache] of MARKET_READS) {
  const label = path.replace(/=[^&]+/g, "=fixture");
  test(`Effect relays the admitted market read ${label}`, async () => {
    const runtime = createEffectHttp({
      upstream: () => ({
        origin: "https://infra.test",
        async fetch(input) {
          assert.equal(String(input), `https://infra.test/v1/${upstreamPath}`);
          return new Response(CANDLE_BODY);
        },
      }),
    });
    const read = createAdmittedMarketRead(
      {
        async consume(key) {
          assert.equal(key, bucket);
          return { allowed: true, bucket: key, policyVersion: 1, retryAfterSeconds: 0 };
        },
      },
      marketSourceBucket,
      runtime.handler,
    );
    try {
      const answer = await read(
        new Request(`https://blast.test/api/launchpad/market/${path}`),
        testClient(),
      );
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get("content-type"), "application/json");
      assert.equal(answer.headers.get("cache-control"), cache);
      assert.equal(await answer.text(), CANDLE_BODY);
    } finally {
      await runtime.dispose();
    }
  });
}

test("Effect market validation rejects ambiguous input before an upstream call", async () => {
  const upstream: () => MarketUpstream = () => ({
    origin: "https://infra.test",
    fetch: () => assert.fail("Invalid reads must not reach upstream."),
  });
  const runtime = createEffectHttp({ upstream });
  const limiter: RateLimitPort = {
    async consume(bucket) {
      return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
    },
  };
  const read = createAdmittedMarketRead(limiter, marketSourceBucket, runtime.handler);
  const legacy = createMarketRoutes({ limiter, upstream });
  const coin = `coins/${encodeURIComponent(COIN)}`;
  const cases = [
    [`${coin}/holders?view=snapshot&%76iew=snapshot`, 400],
    [`${coin}/holders?view=snapshot&cursor=%C3%31`, 400],
    [`${coin}/holders?view=snapshot&limit=101`, 400],
    [`${coin}?__proto__=1`, 400],
    ["partners?cursor=wrong_scope", 400],
    ["creator-claims", 400],
    [`creator-claims?recipient=${CURVE.id}&account=${"f".repeat(64)}`, 400],
    [`pools/blast_curve/${CURVE.id}/trades`, 404],
    ["launchpad/policy/", 404],
    ["coins/%FF", 404],
  ] as const;
  try {
    for (const [path, status] of cases) {
      const request = new Request(`https://blast.test/api/launchpad/market/${path}`);
      const previous = await legacy.handle(request, testClient());
      const answer = await read(request, testClient());
      assert.equal(answer.status, status, path);
      assert.equal(previous.status, status, path);
      assert.equal(answer.headers.get("cache-control"), "private, no-store", path);
      assert.deepEqual((await answer.json()).error, (await previous.json()).error, path);
    }
  } finally {
    await runtime.dispose();
  }
});

test("disconnecting waits for the bounded candle read to finish", { timeout: 2_000 }, async () => {
  const started = Promise.withResolvers<void>();
  const upstream = Promise.withResolvers<Response>();
  const candle = createEffectHttp({
    upstream: () => ({
      origin: "https://infra.test",
      fetch: () => {
        started.resolve();
        return upstream.promise;
      },
    }),
  });
  const caller = new AbortController();
  let settled = false;
  const response = candle
    .handler(
      new Request(`https://blast.test/api/launchpad/market/coins/${COIN}/candles?interval=1m`, {
        signal: caller.signal,
      }),
    )
    .finally(() => {
      settled = true;
    });

  try {
    await started.promise;
    caller.abort();
    await setImmediate();
    assert.equal(settled, false);
  } finally {
    upstream.resolve(new Response(CANDLE_BODY));
    await response;
    await candle.dispose();
  }
});

function candleBody(example: CandleCase): string {
  if (!example.pool || example.pool.venue === "blast_curve") {
    return CANDLE_BODY;
  }
  return JSON.stringify(
    {
      ...CANDLE_PAGE,
      migration: {
        cursor: "22:2:2:0",
        timestamp_ms: 1,
        curve_pool_key: `${CURVE.venue}:${CURVE.id}`,
        venue_pool_key: `${example.pool.venue}:${example.pool.id}`,
      },
    },
    null,
    2,
  );
}

function fixturePaths(example: CandleCase) {
  if (example.read) {
    return {
      publicPath: `/market/${example.read.public}?${example.query}`,
      firstPartyPath: `/market/${example.read.firstParty ?? example.read.public}?${example.query}`,
      upstreamPath: `${example.read.upstream}?${example.wire}`,
    };
  }
  const coin = example.coinType ?? COIN;
  const pool = example.pool && `pools/${example.pool.venue}/${example.pool.id}`;
  const source = pool ?? `coins/${coin}`;
  const encoded = pool ?? `coins/${encodeURIComponent(coin)}`;
  return {
    publicPath: `/market/${example.statusRead ? "status" : `${encoded}/candles`}?${example.query}`,
    upstreamPath: example.statusRead ? "status" : `${source}/candles?${example.wire}`,
  };
}

async function exercise(effect: boolean, examples: readonly CandleCase[]) {
  let current = examples[0]!;
  const upstreamCalls: string[] = [];
  const admissions: string[][] = [];
  const redis = {
    connectionEpoch: () => 0,
    executeAtEpoch: (command: string[]) => redis.execute(command),
    async execute(command: string[]): Promise<unknown> {
      if (command[0] !== "EVALSHA") {
        return null;
      }
      admissions.push(
        command.map((part) =>
          part.replace(/gateway-replay:[A-Za-z0-9_-]{32}$/, "gateway-replay:<nonce>"),
        ),
      );
      return current.status === 429 ? [0, 30, 1] : [1, 0, 0];
    },
  };
  const store = new PartnerRecognitionStore(
    redis,
    NAMESPACE,
    PEPPER,
    partnerCapacity(capacityFixture(["acme"])),
  );
  const recognition = {
    store,
    classify: async () => ({ kind: "known", identity: { tenant: GRANT.id, keyId: GRANT.keyId } }),
    responseWindow: (input: { tenant: string; internal: boolean }) =>
      store.responseWindow(input, 0),
    invalidate: () => assert.fail("The grant matches recognition."),
  } as unknown as PartnerRecognition;
  const upstream = (): MarketUpstream => {
    if (current.status === 503) {
      throw new Error("Fixture has no upstream.");
    }
    return {
      origin: "https://infra.test",
      async fetch(input, init) {
        assert.equal(new Headers(init?.headers).get("accept"), "application/json");
        upstreamCalls.push(String(input));
        if (current.upstreamStatus !== undefined) {
          return Response.json(
            { private_upstream_detail: true },
            { status: current.upstreamStatus },
          );
        }
        return current.statusRead
          ? Response.json({ ...STATUS, engine_id: "private.example", serveable: true })
          : new Response(candleBody(current));
      },
    };
  };
  const effectHttp = effect ? createEffectHttp({ upstream }) : undefined;
  let effectReads = 0;
  const effectRead =
    effectHttp &&
    ((request: Request) => {
      effectReads++;
      return effectHttp.handler(request);
    });
  const unused = async (): Promise<Response> => assert.fail("Only a market handler should run.");
  const handle = createBackendApi({
    redis,
    recognition,
    namespace: NAMESPACE,
    subjectPepper: PEPPER,
    keys: { verify: async () => GRANT, allowsOrigin: async () => true },
    handlers(limiter) {
      const market = effectRead
        ? createAdmittedMarketRead(limiter, marketSourceBucket, effectRead)
        : createMarketRoutes({ limiter, upstream }).handle;
      return {
        market,
        prices: unused,
        presales: unused,
        featured: unused,
        presale: unused,
        discovery: unused,
        search: unused,
        defillama: unused,
        daily_stats: unused,
        wallet_launches: unused,
        presale_proof: unused,
        coin_metadata: unused,
      };
    },
  });
  const runtime = createBackendServer({
    handle,
    preparePartner: handle.preparePartner,
    redis,
    namespace: NAMESPACE,
    gatewaySecret: SECRET,
    ready: async () => true,
  });

  try {
    const relayOptions = { namespace: NAMESPACE, clientAddress: () => "198.18.0.1" };
    const backend = `http://127.0.0.1:${runtime.server.port}`;
    const browser = createBackendRelay(backend, SECRET, { ...relayOptions, firstParty: true });
    const partner = createBackendRelay(backend, SECRET, relayOptions);
    const observations = [];
    for (const example of examples) {
      current = example;
      const method = example.method ?? "GET";
      const { publicPath, firstPartyPath, upstreamPath } = fixturePaths(example);
      const start = upstreamCalls.length;
      const effectBefore = effectReads;
      const first = await browser(
        new Request(`https://blast.test/api/launchpad${firstPartyPath ?? publicPath}`, { method }),
      );
      const paid = await partner(
        new Request(`https://blast.test/api/v1${publicPath}`, {
          method,
          headers: { origin: ORIGIN, "x-blast-partner-key": KEY },
        }),
      );
      const label = `${effect ? "Effect" : "legacy"} ${example.name}`;
      const admitted = example.status !== 429;
      assert.equal(effectReads - effectBefore, effect && admitted ? 2 : 0, label);
      const answers = await assertAnswers(example, method, first, paid, label);
      const expectedCalls =
        example.wire === undefined
          ? []
          : Array<string>(2).fill(`https://infra.test/v1/${upstreamPath}`);
      assert.deepEqual(upstreamCalls.slice(start), expectedCalls, label);
      observations.push(answers);
    }
    return { observations, admissions, upstreamCalls };
  } finally {
    await runtime.drain();
    await effectHttp?.dispose();
  }
}

async function assertAnswers(
  example: CandleCase,
  method: string,
  first: Response,
  paid: Response,
  label: string,
) {
  assert.equal(first.status, example.status, `browser ${label}`);
  assert.equal(paid.status, example.status, `partner ${label}`);
  assert.equal(first.headers.get("cache-control"), example.cache ?? "private, no-store", label);
  assert.equal(paid.headers.get("cache-control"), "private, no-store", label);
  assert.equal(paid.headers.get("access-control-allow-origin"), ORIGIN, label);
  assert.equal(paid.headers.get("x-blast-api-version"), example.status === 429 ? null : "1", label);
  if (example.status === 429 || example.status === 503) {
    assert.ok(first.headers.get("retry-after"), label);
    assert.ok(paid.headers.get("retry-after"), label);
  }
  const browserAnswer = await inspect(first);
  const partnerAnswer = await inspect(paid);
  if (example.status === 200) {
    const expectedBody = example.statusRead ? JSON.stringify(STATUS) : candleBody(example);
    assert.equal(browserAnswer.body, method === "HEAD" ? "" : expectedBody, label);
    assert.equal(partnerAnswer.body, browserAnswer.body, label);
    if (method === "GET" && !example.statusRead && !example.read) {
      const body: unknown = JSON.parse(browserAnswer.body);
      const page = example.pool
        ? parsePoolCandlePage(`${example.pool.venue}:${example.pool.id}`, "1m", body)
        : parseCoinCandlePage(example.coinType ?? COIN, "1m", body);
      assert.equal(page.candles[0]?.volumeQuote, 9007199254740993n, label);
    }
  }
  return { browserAnswer, partnerAnswer };
}

async function inspect(response: Response) {
  const headers = new Headers(response.headers);
  headers.delete("date");
  if (headers.has("x-request-id")) {
    headers.set("x-request-id", "<id>");
  }
  return { status: response.status, headers: [...headers], body: await response.text() };
}
