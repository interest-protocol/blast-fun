import assert from "node:assert/strict";
import test from "node:test";

import { BLAST_DEPLOYMENTS } from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchObject } from "@interest-protocol/blast-sdk/launchpad";
import { bluefinPoolTierBcs, venueWitnessType } from "@interest-protocol/blast-sdk/migrators";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { RpcError, SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag } from "@mysten/sui/utils";

import { NON_PRODUCTION_MANIFEST } from "../../../../core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";

import type { LaunchLifecycle } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";
import {
  COIN_FIXTURE,
  CURVE_POOL_KEY,
  VENUE_POOL_KEY,
  coinBody,
  curvePoolBody,
  errorBody,
  fixtureCoreClient,
  launchObjectFixture,
  venuePoolBody,
  wireProvenance,
} from "../../../../core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { createLastGood, memoizeTradable, readCoinPage, tradableNow, type CoinPageDependencies } from "@blast/server/modules/launchpad-coin/read.ts";
import { refreshIntervalMs } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { configuredLaunchReadChain } from "@blast/server/modules/launchpad-coin/chain.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { installRuntimeConfig } from "../../../test/fixtures/config/runtime-config.ts";
import { configuredSigningChain } from "@blast/core/modules/launchpad-coin/signing-chain.ts";
import { createFreshLaunchReader } from "@blast/server/modules/launchpad-coin/fresh.ts";
import { readNodeCoinMetadata, resolveCoinType } from "@blast/server/modules/launchpad-coin/resolve.ts";
import type { FreshLaunch, RecordedRoute } from "@blast/core/modules/launchpad-coin/fresh-types.ts";

const NOW = 1_790_235_061_630;
const ORIGIN = "https://infra.test";

test("a node-confirmed coin without metadata renders its type name and a missing coin stays missing", async (t) => {
  const rawType = "0x42::_token::_TOKEN";
  const coinType = normalizeStructTag(rawType);
  const db: ReadableDatabase = {
    async read<Row>() {
      const row = { launch_id: null, presale_id: null, metadata_coin_type: null, name: null, symbol: null, iconUrl: null };
      return { rows: [row as Row], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    },
  };
  const node = new SuiGrpcClient({ network: "mainnet", baseUrl: "http://127.0.0.1:1" });
  const call = t.mock.method(node.stateService, "getCoinInfo", async () => ({ response: { coinType: rawType } }));
  const read = () => resolveCoinType(coinType, db, (type) => readNodeCoinMetadata(node, type));

  assert.deepEqual(await read(), { kind: "generic", coinType, name: "_TOKEN", symbol: "_TOKEN" });
  call.mock.mockImplementation(async () => ({ response: { coinType: rawType, metadata: { iconUrl: "https://example.com/token.png" } } }));
  assert.deepEqual(await read(), { kind: "generic", coinType, name: "_TOKEN", symbol: "_TOKEN", iconUrl: "https://example.com/token.png" });
  call.mock.mockImplementation(async () => { throw new RpcError("Unknown coin", "NOT_FOUND"); });
  assert.deepEqual(await read(), { kind: "not-found", coinType });
});

type Answer = Readonly<{ status: number; body: unknown }> | "unreachable";

/** blast-infra as a route table: path -> answer; anything else is a 404. */
function infra(routes: Record<string, Answer>, seen: string[] = []): MarketDataDependencies {
  return {
    origin: ORIGIN,
    now: () => NOW,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: (async (input: URL | string) => {
      const url = new URL(String(input));
      const path = `${url.pathname}${url.search}`;
      seen.push(path);
      if (path === "/v1/status") {
        return Response.json({ provenance: wireProvenance(NOW), checkpoint: 1, timestamp_ms: 1, lag_ms: 1, cursor: null, engine_id: "fixture" });
      }
      const answer = routes[path] ?? { status: 404, body: errorBody("not_found", "no such pool") };
      if (answer === "unreachable") throw new TypeError("fetch failed");
      return Response.json(answer.body, { status: answer.status });
    }) as typeof fetch,
  };
}

const CURVE_PATH = `/v1/pools/blast_curve/${COIN_FIXTURE.launchId}`;
const COIN_PATH = `/v1/coins/${COIN_FIXTURE.coinType}`;
const VENUE_PATH = `/v1/pools/bluefin/${COIN_FIXTURE.venuePoolId}`;

function indexed(lifecycle: LaunchLifecycle, lagMs?: number): Record<string, Answer> {
  return {
    [CURVE_PATH]: { status: 200, body: curvePoolBody(lifecycle, NOW, lagMs) },
    [COIN_PATH]: { status: 200, body: coinBody(lifecycle, NOW, lagMs) },
    [VENUE_PATH]: { status: 200, body: venuePoolBody(NOW, lagMs) },
  };
}

const ABSENT: FreshLaunch = { status: "absent", readAtMs: NOW };

function dependencies(
  routes: Record<string, Answer>,
  fresh: FreshLaunch | ((launchId: string) => FreshLaunch) = ABSENT,
  extra: Partial<CoinPageDependencies> = {},
): CoinPageDependencies {
  return {
    market: infra(routes),
    readFresh: async (launchId) => (typeof fresh === "function" ? fresh(launchId) : fresh),
    lastGood: createLastGood(),
    ...extra,
  };
}

test("an unknown launch is not found when blast-infra and the node both deny it", async () => {
  const read = await readCoinPage(COIN_FIXTURE.unknownLaunchId, dependencies({}));
  assert.deepEqual(read, { kind: "not-found" });
});

test("a known launch reads its curve with blast-infra's provenance", async () => {
  const read = await readCoinPage(COIN_FIXTURE.launchId, dependencies(indexed("live")));
  assert.equal(read.kind, "coin");
  if (read.kind !== "coin") return;
  assert.equal(read.page.launchId, COIN_FIXTURE.launchId);
  assert.equal(read.page.curve.state, "available");
  if (read.page.curve.state !== "available") return;
  assert.equal(read.page.curve.data.launch.poolKey, CURVE_POOL_KEY);
  assert.equal(read.page.curve.data.launch.lifecycle, "live");
  assert.equal(read.page.curve.provenance.checkpoint, 326_274_009);
  assert.equal(read.page.curve.provenance.lagMs, 412);
});

const ROUTE: RecordedRoute = { venue: "bluefin", tickSpacing: 60, feeRate: 3000n, supported: true, reason: null };

function freshAt(lifecycle: LaunchLifecycle, route: RecordedRoute = ROUTE): FreshLaunch {
  return { status: "read", launch: decodeLaunchObject(launchObjectFixture(lifecycle)), route, readAtMs: NOW };
}

test("a launch the node shows but blast-infra has not indexed yet keeps its page", async () => {
  const read = await readCoinPage(COIN_FIXTURE.launchId, dependencies({}, freshAt("live")));
  assert.equal(read.kind, "coin");
  if (read.kind !== "coin") return;
  assert.equal(read.page.curve.state, "unavailable");
  assert.equal(read.page.curve.state === "unavailable" && read.page.curve.reason, "not_found");
});

test("when blast-infra cannot answer, the node decides whether the ID is a launch", async () => {
  const down = { [CURVE_PATH]: "unreachable" as const };
  const foreign: FreshLaunch = { status: "foreign", readAtMs: NOW, reason: "not a launch" };
  assert.deepEqual(await readCoinPage(COIN_FIXTURE.launchId, dependencies(down, foreign)), { kind: "not-found" });
  assert.deepEqual(await readCoinPage(COIN_FIXTURE.launchId, dependencies(down, ABSENT)), { kind: "not-found" });

  // Neither can answer: the page renders, Unavailable, rather than claim the launch does not exist.
  const nodeDown: FreshLaunch = { status: "unavailable", reason: "The Sui node did not answer." };
  const read = await readCoinPage(COIN_FIXTURE.launchId, dependencies(down, nodeDown));
  assert.equal(read.kind, "coin");
  assert.equal(read.kind === "coin" && read.page.curve.state, "unavailable");
  assert.equal(read.kind === "coin" && read.page.curve.state === "unavailable" && read.page.curve.reason, "unreachable");
});

test("an outage serves the last answer Stale with its own provenance, never a recomputed value", async () => {
  const lastGood = createLastGood();
  const routes: Record<string, Answer> = { ...indexed("live") };
  const first = await readCoinPage(COIN_FIXTURE.launchId, dependencies(routes, ABSENT, { lastGood }));
  assert.equal(first.kind === "coin" && first.page.curve.state, "available");

  for (const outage of ["unreachable", { status: 503, body: errorBody("not_ready", "starting") }] as const) {
    routes[CURVE_PATH] = outage;
    const read = await readCoinPage(COIN_FIXTURE.launchId, dependencies(routes, ABSENT, { lastGood }));
    assert.equal(read.kind, "coin", "a known launch keeps its page through an outage");
    if (read.kind !== "coin" || read.page.curve.state !== "stale") return assert.fail("expected stale");
    assert.equal(read.page.curve.reason, outage === "unreachable" ? "unreachable" : "not_ready");
    assert.equal(read.page.curve.data.launch.lifecycle, "live");
    assert.equal(read.page.curve.provenance.checkpoint, 326_274_009, "the last answer's checkpoint");
    assert.equal(read.page.curve.provenance.observedAt, NOW);
  }

  // Another launch never borrows this one's answer.
  routes[`/v1/pools/blast_curve/${COIN_FIXTURE.unknownLaunchId}`] = "unreachable";
  const other = await readCoinPage(COIN_FIXTURE.unknownLaunchId, dependencies(routes, { status: "unavailable", reason: "down" }, { lastGood }));
  assert.equal(other.kind === "coin" && other.page.curve.state, "unavailable");
});

test("a lagging or halted engine's answer is Stale with its lag", async () => {
  const read = await readCoinPage(COIN_FIXTURE.launchId, dependencies(indexed("live", 45_000)));
  assert.equal(read.kind === "coin" && read.page.curve.state, "stale");
  if (read.kind !== "coin" || read.page.curve.state !== "stale") return;
  assert.equal(read.page.curve.reason, "lagging");
  assert.equal(read.page.curve.provenance.lagMs, 45_000);
});

test("an answer that breaks the contract is Unavailable, never a partial page", async () => {
  const body = curvePoolBody("live", NOW) as { pool: Record<string, unknown> };
  const broken = { ...body, pool: { ...body.pool, pool_id: COIN_FIXTURE.unknownLaunchId, pool_key: `blast_curve:${COIN_FIXTURE.unknownLaunchId}` } };
  const read = await readCoinPage(COIN_FIXTURE.launchId, dependencies({ [CURVE_PATH]: { status: 200, body: broken } }, freshAt("live")));
  assert.equal(read.kind === "coin" && read.page.curve.state, "unavailable");
  assert.equal(read.kind === "coin" && read.page.curve.state === "unavailable" && read.page.curve.reason, "contract-violation");
});

async function page(routes: Record<string, Answer>, fresh: FreshLaunch) {
  const read = await readCoinPage(COIN_FIXTURE.launchId, dependencies(routes, fresh));
  if (read.kind !== "coin") throw new Error("expected a coin page");
  return read.page;
}

test("a live launch composes the curve and coin summaries and trades on the curve", async () => {
  const live = await page(indexed("live"), freshAt("live"));
  assert.equal(live.coin.state, "available");
  if (live.coin.state !== "available") return;
  assert.equal(live.coin.data.creator, COIN_FIXTURE.creator);
  assert.equal(live.coin.data.creatorSource, "address");
  assert.equal(live.coin.data.currentPool, CURVE_POOL_KEY);
  assert.equal(live.coin.data.stats.holders, 184);
  assert.equal(live.coin.data.supply, 999_998_000_000_000n);
  assert.equal(live.coin.data.marketCap, 2_528_730_574_712n);
  assert.equal(live.coin.data.decimals, 6);
  assert.equal(live.coin.data.quoteDecimals, 9);
  assert.equal(live.coin.data.stats.day.volumeUsd, "1070.151");
  assert.equal(live.venue, null, "no venue before migration");
  assert.deepEqual(live.source, { kind: "curve", poolKey: CURVE_POOL_KEY });
  assert.deepEqual(live.availability, { kind: "curve" });
  assert.equal(live.conflict, null);
  assert.equal(live.tradable, true);
});

test("an opening round takes bids, not trades, until its end", async () => {
  const opening = await page(indexed("opening_round"), freshAt("opening_round"));
  assert.deepEqual(opening.availability, { kind: "opening-round", endsAtMs: 1_790_203_600_000n });
  assert.equal(opening.tradable, false);
  assert.deepEqual(opening.source, { kind: "curve", poolKey: CURVE_POOL_KEY });
});

test("migration-ready blocks curve trading and offers migration only on a supported recorded route", async () => {
  const ready = await page(indexed("migration_ready"), freshAt("migration_ready"));
  assert.deepEqual(ready.availability, { kind: "migration-ready", route: ROUTE });
  assert.equal(ready.tradable, false);

  const foreignRoute: RecordedRoute = { venue: "cetus", tickSpacing: 60, feeRate: 3000n, supported: false, reason: "the launch migrates through another migrators package" };
  const unsupported = await page(indexed("migration_ready"), freshAt("migration_ready", foreignRoute));
  assert.deepEqual(unsupported.availability, { kind: "migration-ready", route: foreignRoute });
});

test("a migrated launch selects its recorded venue and keeps its curve history", async () => {
  const migrated = await page(indexed("migrated"), freshAt("migrated"));
  assert.deepEqual(migrated.source, { kind: "venue", venue: "bluefin", poolKey: VENUE_POOL_KEY });
  assert.equal(migrated.venue?.state, "available");
  if (migrated.venue?.state !== "available") return;
  assert.equal(migrated.venue.data.poolKey, VENUE_POOL_KEY);
  assert.equal(migrated.venue.data.economics.price, "0.015625");
  assert.equal(migrated.venue.data.stats.holders, 212);
  assert.deepEqual(migrated.availability, { kind: "venue", route: ROUTE, poolKey: VENUE_POOL_KEY });
  assert.equal(migrated.tradable, true);
  // The curve's own record stays: its lifecycle, launch facts and migration.
  assert.equal(migrated.curve.state === "available" && migrated.curve.data.launch.migration?.poolKey, VENUE_POOL_KEY);
  assert.equal(migrated.coin.state === "available" && migrated.coin.data.currentPool, VENUE_POOL_KEY);
});

test("unavailable venue data disables trading and never reopens the curve", async () => {
  const routes = { ...indexed("migrated"), [VENUE_PATH]: { status: 503, body: errorBody("not_ready", "starting") } };
  const migrated = await page(routes, freshAt("migrated"));
  assert.equal(migrated.venue?.state, "unavailable");
  assert.equal(migrated.availability.kind, "venue-unavailable");
  assert.equal(migrated.tradable, false);
  assert.deepEqual(migrated.source, { kind: "venue", venue: "bluefin", poolKey: VENUE_POOL_KEY });

  const unsupported: RecordedRoute = { ...ROUTE, supported: false, reason: "unsupported migration route" };
  const unrouted = await page(indexed("migrated"), freshAt("migrated", unsupported));
  assert.deepEqual(unrouted.availability, { kind: "venue-unavailable", route: unsupported, reason: "unsupported migration route" });
});

test("an indexed/fresh lifecycle conflict is shown and the launch object decides eligibility", async () => {
  const behind = await page(indexed("live"), freshAt("migration_ready"));
  assert.deepEqual(behind.conflict, { indexed: "live", fresh: "migration_ready" });
  assert.equal(behind.availability.kind, "migration-ready");
  assert.equal(behind.tradable, false);
  assert.equal(behind.curve.state === "available" && behind.curve.data.launch.lifecycle, "live", "indexed facts are not rewritten");

  const ahead = await page(indexed("migration_ready"), freshAt("live"));
  assert.deepEqual(ahead.conflict, { indexed: "migration_ready", fresh: "live" });
  assert.deepEqual(ahead.availability, { kind: "curve" });
  assert.equal(ahead.tradable, true);
});

test("without a fresh launch object nothing is tradable, whatever blast-infra says", async () => {
  for (const fresh of [
    { status: "unavailable", reason: "The Sui node did not answer." },
    { status: "absent", readAtMs: NOW },
  ] satisfies FreshLaunch[]) {
    const live = await page(indexed("live"), fresh);
    assert.equal(live.availability.kind, "unverified");
    if (fresh.status === "unavailable") assert.deepEqual(live.availability, { kind: "unverified", reason: fresh.reason });
    assert.equal(live.tradable, false);
    assert.equal(live.conflict, null);
  }
  const otherCoin: FreshLaunch = {
    ...(freshAt("live") as Extract<FreshLaunch, { status: "read" }>),
    launch: decodeLaunchObject(launchObjectFixture("live", { memeType: `0x${"77".repeat(32)}::other::OTHER` })),
  };
  const mismatched = await page(indexed("live"), otherCoin);
  assert.equal(mismatched.availability.kind, "unverified");
});

test("the fresh reader decodes this deployment's launch and its recorded route through the SDK", async () => {
  const manifest = NON_PRODUCTION_MANIFEST;
  const migrators = manifest.packages.migrators;
  const chain = (objects: Record<string, ReturnType<typeof launchObjectFixture>>) => {
    const client = fixtureCoreClient((id) => objects[id] ?? null);
    const tierType = `${migrators.originalPackageId}::bluefin::PoolTier`;
    return {
      client: {
        core: {
          ...client.core,
          async getDynamicField({ parentId, name }: { parentId: string; name: { type: string } }) {
            assert.equal(parentId, manifest.sharedObjects.migrators.venueConfig.objectId);
            assert.equal(normalizeStructTag(name.type), normalizeStructTag(`${tierType}Key<${COIN_FIXTURE.coinType}>`));
            const bytes = bluefinPoolTierBcs.serialize({ tick_spacing: 60, fee_rate: 3000n }).toBytes();
            return { dynamicField: { value: { type: tierType, bcs: bytes } } };
          },
        },
      } as ClientWithCoreApi,
      manifest,
    };
  };
  const live = await createFreshLaunchReader(chain({ [COIN_FIXTURE.launchId]: launchObjectFixture("live") }), () => NOW)(COIN_FIXTURE.launchId);
  assert.equal(live.status, "read");
  if (live.status !== "read") return;
  assert.equal(live.launch.lifecycle, "Live");
  assert.equal(live.launch.memeType, COIN_FIXTURE.coinType);
  assert.deepEqual(live.route, ROUTE);
  assert.equal(live.readAtMs, NOW);

  // A witness of another migrators package, or a venue the deployment does not admit, is unsupported.
  const elsewhere = launchObjectFixture("migration_ready", { migrationWitness: `0x${"ab".repeat(32)}::cetus::Venue` });
  const foreignRoute = await createFreshLaunchReader(chain({ [COIN_FIXTURE.launchId]: elsewhere }), () => NOW)(COIN_FIXTURE.launchId);
  assert.equal(foreignRoute.status === "read" && foreignRoute.route.supported, false);
  assert.equal(foreignRoute.status === "read" && foreignRoute.route.venue, "cetus");
  const cetus = launchObjectFixture("migration_ready", { migrationWitness: venueWitnessType(migrators, "cetus") });
  const unadmitted = await createFreshLaunchReader(chain({ [COIN_FIXTURE.launchId]: cetus }), () => NOW)(COIN_FIXTURE.launchId);
  assert.equal(unadmitted.status === "read" && unadmitted.route.supported, false);
  assert.match(unadmitted.status === "read" ? unadmitted.route.reason ?? "" : "", /not admitted by the deployment/);

  assert.deepEqual(await createFreshLaunchReader(chain({}), () => NOW)(COIN_FIXTURE.launchId), { status: "absent", readAtMs: NOW });
  const impostor = launchObjectFixture("live", { launchpadPackage: `0x${"f0".repeat(32)}` });
  const foreign = await createFreshLaunchReader(chain({ [COIN_FIXTURE.launchId]: impostor }), () => NOW)(COIN_FIXTURE.launchId);
  assert.equal(foreign.status, "foreign");

  const down = { client: fixtureCoreClient(() => Promise.reject(new Error("connect ECONNREFUSED"))), manifest: NON_PRODUCTION_MANIFEST };
  assert.deepEqual(await createFreshLaunchReader(down, () => NOW)(COIN_FIXTURE.launchId), {
    status: "unavailable",
    reason: "The launch object could not be read from Sui just now.",
  });
  // fetch's own TypeError is an unreachable node, not a foreign object.
  const offline = { client: fixtureCoreClient(() => Promise.reject(new TypeError("fetch failed"))), manifest: NON_PRODUCTION_MANIFEST };
  assert.equal((await createFreshLaunchReader(offline, () => NOW)(COIN_FIXTURE.launchId)).status, "unavailable");
  assert.deepEqual(await createFreshLaunchReader(null, () => NOW)(COIN_FIXTURE.launchId), {
    status: "unavailable",
    reason: "This app is not connected to a released Blast deployment, so launch objects cannot be read.",
  });
});

test("configured chains ignore fixture origins: the server reads the released manifest through its own node", async () => {
  // This fails if a fixture origin could replace the configured deployment or node.
  installRuntimeConfig({ NODE_ENV: "production", LAUNCHPAD_FIXTURE_CHAIN_ORIGIN: "http://127.0.0.1:3112" });
  const mainnet = await configuredLaunchReadChain();
  assert.equal(mainnet?.manifest, BLAST_DEPLOYMENTS.mainnet);
  assert.equal(runtimeConfig().suiNodeUrl.startsWith("https://"), true);
});

test("the curve carries its snapshotted plan, split, SDK economics and progress", async () => {
  const live = await page(indexed("live"), freshAt("live"));
  if (live.curve.state !== "available") return assert.fail("expected the curve");
  const { plan, split, economics, progressBps } = live.curve.data;
  assert.deepEqual(plan, { curveMemeBps: 8000n, lpMemeBps: 1900n, lpQuoteBps: 9800n, protocolMemeBps: 100n, protocolQuoteBps: 200n, recipients: [] });
  assert.deepEqual(split, { routes: [
    { destination: { kind: "Owner" }, bps: 5000n },
    { destination: { kind: "AutoLp" }, bps: 2000n },
    { destination: { kind: "HolderRewards" }, bps: 2000n },
    { destination: { kind: "Burn" }, bps: 1000n },
  ] });
  // Worked by hand from the fixture: 10^15 atoms, 1.5e12 virtual and 3e12 target Quote.
  assert.deepEqual(economics, {
    curveMeme: 800_000_000_000_000n,
    liquidityMeme: 190_000_000_000_000n,
    liquidityQuote: 2_940_000_000_000n,
    allocatedQuote: 60_000_000_000n,
    // Blast's migration allocation, accrued as protocol fees at migration.
    protocolMeme: 10_000_000_000_000n,
    protocolQuote: 60_000_000_000n,
    terminalCurveMeme: 266_666_666_666_667n,
    curveMemeReleased: 533_333_333_333_333n,
    openingValuation: 1_875_000_000_000n,
    curveTerminalValuation: 16_874_999_999_999n,
    dexOpeningValuation: 15_473_684_210_526n,
  });
  assert.equal(progressBps, 866n);
  const ready = await page(indexed("migration_ready"), freshAt("migration_ready"));
  assert.equal(ready.curve.state === "available" && ready.curve.data.progressBps, 10_000n);

  // A plan that breaks the contract makes the curve Unavailable rather than guessing.
  const body = curvePoolBody("live", NOW) as { pool: { launch: Record<string, unknown> } };
  const broken = { ...body, pool: { ...body.pool, launch: { ...body.pool.launch, allocation_plan: { curve_meme_bps: 8000 } } } };
  const refused = await page({ ...indexed("live"), [CURVE_PATH]: { status: 200, body: broken } }, freshAt("live"));
  assert.equal(refused.curve.state, "unavailable");
});

test("without a configured blast-infra origin the page renders Unavailable instead of failing", async () => {
  const read = await readCoinPage(COIN_FIXTURE.launchId, { ...dependencies({}, { status: "unavailable", reason: "no chain" }), market: null });
  assert.equal(read.kind, "coin");
  if (read.kind !== "coin") return;
  assert.deepEqual(
    [read.page.curve.state, read.page.coin.state],
    ["unavailable", "unavailable"],
  );
  assert.equal(read.page.curve.state === "unavailable" && read.page.curve.reason, "unconfigured");
});

test("the page refreshes fastest while its sources disagree or blast-infra is degraded", async () => {
  assert.equal(refreshIntervalMs(await page(indexed("live"), freshAt("live"))), 30_000);
  assert.equal(refreshIntervalMs(await page(indexed("live", 45_000), freshAt("live"))), 10_000);
  assert.equal(refreshIntervalMs(await page({ ...indexed("live"), [COIN_PATH]: "unreachable" }, freshAt("live"))), 10_000);
  assert.equal(refreshIntervalMs(await page(indexed("live"), freshAt("migration_ready"))), 5_000);
});

test("telemetry asks the coin page whether a launch is tradable now", async () => {
  assert.equal(await tradableNow(COIN_FIXTURE.launchId, dependencies(indexed("live"), freshAt("live"))), "tradable");
  assert.equal(await tradableNow(COIN_FIXTURE.launchId, dependencies(indexed("migrated"), freshAt("migrated"))), "tradable");
  assert.equal(await tradableNow(COIN_FIXTURE.launchId, dependencies(indexed("migration_ready"), freshAt("migration_ready"))), "not-tradable");
  assert.equal(await tradableNow(COIN_FIXTURE.launchId, dependencies(indexed("opening_round"), freshAt("opening_round"))), "not-tradable");
  assert.equal(await tradableNow(COIN_FIXTURE.unknownLaunchId, dependencies({})), "not-tradable");
  assert.equal(
    await tradableNow(COIN_FIXTURE.launchId, dependencies(indexed("live"), { status: "unavailable", reason: "node down" })),
    "unavailable",
  );
});

/** A node that accepts every request and never answers; it records the abort it was given. */
function hangingNode() {
  const signals: (AbortSignal | undefined)[] = [];
  const client = {
    core: {
      getObject: ({ signal }: { signal?: AbortSignal }) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    },
  } as unknown as ReturnType<typeof fixtureCoreClient>;
  return { client, signals };
}

test("a node that never answers is Unavailable after the fresh-read deadline, and the call is aborted", async () => {
  const { client, signals } = hangingNode();
  const started = performance.now();
  const read = await createFreshLaunchReader({ client, manifest: NON_PRODUCTION_MANIFEST }, () => NOW, { timeoutMs: 50 })(COIN_FIXTURE.launchId);
  assert.deepEqual(read, { status: "unavailable", reason: "The launch object could not be read from Sui just now." });
  assert.ok(performance.now() - started < 1_000);
  assert.equal(signals[0]?.aborted, true, "the node request is aborted at the deadline");
});

test("the page read and the telemetry check finish within their deadlines on a never-settling node", async () => {
  const { client } = hangingNode();
  const readFresh = createFreshLaunchReader({ client, manifest: NON_PRODUCTION_MANIFEST }, () => NOW, { timeoutMs: 50 });
  const started = performance.now();
  const read = await readCoinPage(COIN_FIXTURE.launchId, { ...dependencies(indexed("live")), readFresh });
  assert.equal(read.kind, "coin");
  assert.equal(read.kind === "coin" && read.page.availability.kind, "unverified");
  assert.ok(performance.now() - started < 1_000);

  // Telemetry gives the whole check its own, shorter budget, whatever the reads do.
  const stalled: CoinPageDependencies = { ...dependencies({}), readFresh: () => new Promise(() => undefined) };
  const checking = performance.now();
  assert.equal(await tradableNow(COIN_FIXTURE.launchId, stalled, { timeoutMs: 50 }), "unavailable");
  assert.ok(performance.now() - checking < 1_000);
});

test("venue trading follows this request's venue read, not a remembered one", async () => {
  const lastGood = createLastGood();
  const routes: Record<string, Answer> = { ...indexed("migrated") };
  const warm = await readCoinPage(COIN_FIXTURE.launchId, dependencies(routes, freshAt("migrated"), { lastGood }));
  assert.equal(warm.kind === "coin" && warm.page.availability.kind, "venue");

  // The venue read fails now: the remembered facts stay on screen, Stale, but trading closes.
  routes[VENUE_PATH] = { status: 503, body: errorBody("not_ready", "starting") };
  const failed = await readCoinPage(COIN_FIXTURE.launchId, dependencies(routes, freshAt("migrated"), { lastGood }));
  if (failed.kind !== "coin") return assert.fail("expected the page");
  assert.equal(failed.page.venue?.state, "stale");
  assert.deepEqual(failed.page.availability, { kind: "venue-unavailable", route: ROUTE, reason: "not_ready" });
  assert.equal(failed.page.tradable, false);
  assert.equal(await tradableNow(COIN_FIXTURE.launchId, dependencies(routes, freshAt("migrated"), { lastGood })), "not-tradable");

  // A venue answer that is only lagging is this request's answer: trading stays.
  const lagging = await readCoinPage(COIN_FIXTURE.launchId, dependencies(indexed("migrated", 45_000), freshAt("migrated"), { lastGood }));
  if (lagging.kind !== "coin") return assert.fail("expected the page");
  assert.equal(lagging.page.venue?.state, "stale");
  assert.equal(lagging.page.availability.kind, "venue");
  assert.equal(await tradableNow(COIN_FIXTURE.launchId, dependencies(indexed("migrated", 45_000), freshAt("migrated"), { lastGood })), "tradable");
});

test("an ID neither blast-infra nor the node can confirm is marked unconfirmed", async () => {
  const down = { [CURVE_PATH]: "unreachable" as const };
  const nodeDown: FreshLaunch = { status: "unavailable", reason: "The Sui node did not answer." };
  const unknown = await readCoinPage(COIN_FIXTURE.launchId, dependencies(down, nodeDown));
  assert.equal(unknown.kind === "coin" && unknown.page.confirmed, false);

  // The node alone, or blast-infra's remembered answer, confirms it.
  const nodeOnly = await readCoinPage(COIN_FIXTURE.launchId, dependencies(down, freshAt("live")));
  assert.equal(nodeOnly.kind === "coin" && nodeOnly.page.confirmed, true);
  const lastGood = createLastGood();
  await readCoinPage(COIN_FIXTURE.launchId, dependencies(indexed("live"), nodeDown, { lastGood }));
  const remembered = await readCoinPage(COIN_FIXTURE.launchId, dependencies(down, nodeDown, { lastGood }));
  assert.equal(remembered.kind === "coin" && remembered.page.confirmed, true);
});

test("telemetry reuses a launch's tradability decision for a few seconds, never an unknown one", async () => {
  let clock = 0;
  const answers: Array<"tradable" | "not-tradable" | "unavailable"> = ["unavailable", "tradable", "not-tradable"];
  const asked: string[] = [];
  const verify = memoizeTradable(async (launchId) => {
    asked.push(launchId);
    return answers.shift()!;
  }, { ttlMs: 5_000, now: () => clock });

  assert.equal(await verify(COIN_FIXTURE.launchId), "unavailable");
  assert.equal(await verify(COIN_FIXTURE.launchId), "tradable", "an unknown answer is asked again");
  clock = 4_999;
  assert.equal(await verify(COIN_FIXTURE.launchId), "tradable", "a decision is reused within its window");
  clock = 5_001;
  assert.equal(await verify(COIN_FIXTURE.launchId), "not-tradable", "and re-checked after it");
  assert.equal(asked.length, 3);
});

test("browsers sign only against a released deployment's fullnode; the fixture origin and unknown networks give no signing chain", () => {
  // Mainnet is the one released deployment: browsers sign on its public fullnode, in production mode.
  const mainnet = configuredSigningChain({ BLAST_NETWORK: "mainnet" });
  assert.equal(mainnet?.manifest, BLAST_DEPLOYMENTS.mainnet);
  assert.equal(mainnet?.mode, "production");
  assert.equal(configuredSigningChain({ BLAST_NETWORK: "testnet" }), null);
  assert.equal(configuredSigningChain({ BLAST_NETWORK: "nowhere" }), null);
  assert.equal(configuredSigningChain({}), null);
  // The development fixture origin serves objects only; it cannot simulate or execute a migration.
  assert.equal(configuredSigningChain({ NODE_ENV: "development", LAUNCHPAD_FIXTURE_CHAIN_ORIGIN: "http://127.0.0.1:3112" }), null);
});

test("the fixture engine serves the coin's holder snapshot to the app's server: complete pages, incomplete, behind, zero and outages", async () => {
  const { startCoinFixtureServer } = await import("../../../../core/test/fixtures/modules/launchpad-coin/fixture-server.ts");
  const { readHoldersSnapshot } = await import("@blast/core/modules/launchpad-contract/holders.ts");
  const { HOLDER_BEHIND_CHECKPOINT, FIXTURE_HOLDERS } = await import("../../../../core/test/fixtures/modules/launchpad-coin/holder-fixtures.ts");
  const server = await startCoinFixtureServer();
  try {
    const market: MarketDataDependencies = { origin: server.origin, fetch, now: Date.now, timeoutMs: 1_000, statusCacheMs: 0, expected: null };
    const read = (cursor: string | null = null) => readHoldersSnapshot(COIN_FIXTURE.coinType, COIN_FIXTURE.launchId, { cursor }, market);
    const page = async (cursor: string | null = null) => {
      const answer = await read(cursor);
      assert.notEqual(answer.status, "unavailable");
      if (answer.status === "unavailable" || answer.data.kind !== "answer") throw new Error("expected a snapshot page");
      return answer.data.value;
    };

    const response = await fetch(`${server.origin}/v1/coins/${COIN_FIXTURE.coinType}/holders?view=snapshot&limit=25`, {
      headers: { Origin: "http://127.0.0.1:3112" },
    });
    assert.equal(response.headers.get("access-control-allow-origin"), null, "no browser reads it: only the app's server (WP2)");

    const first = await page();
    assert.equal(first.snapshot.state, "complete");
    assert.equal(first.facts?.holderCount, 30n);
    assert.equal(first.facts?.holders.length, 25);
    const second = await page(first.facts?.nextCursor ?? null);
    assert.deepEqual([...(first.facts?.holders ?? []), ...(second.facts?.holders ?? [])].map((row) => row.address), FIXTURE_HOLDERS.map((holder) => holder.address));
    assert.equal(second.facts?.nextCursor, null);

    Object.assign(server.state, { holders: "incomplete" });
    assert.equal((await page()).facts, null);
    Object.assign(server.state, { holders: "behind" });
    assert.equal((await page()).snapshot.checkpoint, HOLDER_BEHIND_CHECKPOINT);
    Object.assign(server.state, { holders: "zero" });
    assert.equal((await page()).facts?.holderCount, 0n);

    Object.assign(server.state, { holders: "complete", infra: "starting" });
    assert.deepEqual(await read().then((answer) => answer.status === "unavailable" && answer.provenance.reason), "not_ready");
    Object.assign(server.state, { infra: "lagging" });
    assert.equal((await read()).status, "stale");
  } finally {
    await server.close();
  }
});
