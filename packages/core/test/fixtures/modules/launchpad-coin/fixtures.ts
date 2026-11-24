// Fixtures for the permanent coin page: one Blast launch (the docs/api.md
// Froggy curve) through all four lifecycles as blast-infra `/v1` serves it,
// its Bluefin migration pool, and its launch object as the node stores it.
// They serve tests and the dev fixture server, never real value. The `/v1`
// bodies validate against blast-infra's docs/api/schemas (pool.json and
// coin.json).

import { launchBcs, type LaunchObject } from "@interest-protocol/blast-sdk/launchpad";
import { ObjectError, TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { NON_PRODUCTION_MANIFEST } from "./manifest-fixtures.ts";
import type { LaunchLifecycle } from "../../../../src/modules/launchpad-contract/discovery.ts";
import { outcomeTransactionFromWire, outcomeTransactionResult } from "../launchpad-telemetry/outcome-fixtures.ts";

const LAUNCHPAD = NON_PRODUCTION_MANIFEST.packages.launchpad.originalPackageId;
const MIGRATORS = NON_PRODUCTION_MANIFEST.packages.migrators.originalPackageId;

export const COIN_FIXTURE = Object.freeze({
  launchId: "0xa1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
  coinType: "0x3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c3f1e8b2c::froggy::FROGGY",
  quoteType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  venuePoolId: `0x${"b1".repeat(32)}`,
  creator: "0x5e9f0b175e9f0b175e9f0b175e9f0b175e9f0b175e9f0b175e9f0b175e9f0b17",
  partnerId: "0x00000000000000000000000000000000000000000000000000000000000000bb",
  /** The recorded adapter: this fixture deployment's Bluefin route, 60 / 3000. */
  migrationWitness: `${MIGRATORS}::bluefin::Venue`,
  /** A launch ID no deployment knows. */
  unknownLaunchId: `0x${"0e".repeat(32)}`,
});

export const CURVE_POOL_KEY = `blast_curve:${COIN_FIXTURE.launchId}`;
export const VENUE_POOL_KEY = `bluefin:${COIN_FIXTURE.venuePoolId}`;

export const FIXTURE_LAG_MS = 412;

/** blast-infra's wire provenance at `now`, `lagMs` behind. */
export function wireProvenance(now: number, lagMs = FIXTURE_LAG_MS): Record<string, unknown> {
  return {
    network: "localnet",
    deployment_fingerprint: "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c",
    checkpoint: 326_274_009,
    timestamp_ms: now - lagMs,
    observed_ms: now,
    lag_ms: lagMs,
  };
}

function window(volumeQuote: string, volumeUsd: string | null, buys: number, sells: number) {
  return { volume_quote: volumeQuote, volume_usd: volumeUsd, buys, sells, trades: buys + sells };
}

const QUIET_WINDOWS = {
  "5m": window("0", null, 0, 0),
  "1h": window("0", null, 0, 0),
  "6h": window("0", null, 0, 0),
  "24h": window("0", null, 0, 0),
  all: window("0", null, 0, 0),
};

const TRADED_WINDOWS = {
  "5m": window("12000000000", "41.4252", 2, 1),
  "1h": window("42500000000", "146.71425", 3, 1),
  "6h": window("128000000000", "441.8688", 9, 4),
  "24h": window("310000000000", "1070.151", 21, 8),
  all: window("410000000000", "1415.361", 27, 11),
};

const flow = (net: string, buyers: number, sellers: number) => ({ net_quote_flow: net, buyers, sellers });

/**
 * The curve summary's flow fields (curve summaries only), window by window.
 * They count curve buys and sells alone, never the opening-round settlement:
 * `all` has fewer buyers than the window's buys, which include the pot's buy.
 */
const CURVE_FLOW = {
  traded: {
    "5m": flow("4000000000", 2, 1),
    "1h": flow("21500000000", 3, 1),
    "6h": flow("-6400000000", 6, 4),
    "24h": flow("152000000000", 9, 5),
    all: flow("188000000000", 11, 6),
  },
  quiet: { "5m": flow("0", 0, 0), "1h": flow("0", 0, 0), "6h": flow("0", 0, 0), "24h": flow("0", 0, 0), all: flow("0", 0, 0) },
} as const;

function withFlow(windows: Readonly<Record<string, object>>, flows: Readonly<Record<string, object>>) {
  return Object.fromEntries(Object.entries(windows).map(([name, window]) => [name, { ...window, ...flows[name] }]));
}

/** A curve summary's windows as a coin summary's: without flow fields. */
export function withoutFlow(windows: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(windows as Record<string, Record<string, unknown>>).map(([name, window]) => [
      name,
      Object.fromEntries(Object.entries(window).filter(([key]) => !["net_quote_flow", "buyers", "sellers"].includes(key))),
    ]),
  );
}

const QUOTE_USD = { price: "345210000", expo: -8, publish_time: 1_790_235_060, age_ms: 1218 };

const METADATA = {
  name: "Froggy",
  symbol: "FROGGY",
  description: "A frog that kept its launch page through every lifecycle.",
  icon_url: "https://example.com/froggy.png",
};

const LAUNCH_SETTINGS = {
  venue: COIN_FIXTURE.migrationWitness,
  expected_vault_id: null,
  pool_tier: { tick_spacing: "60", fee_rate: "3000" },
  lp_fee_split: { routes: [
    { destination: { kind: "owner" }, bps: "5000" },
    { destination: { kind: "auto_lp" }, bps: "2000" },
    { destination: { kind: "holder_rewards" }, bps: "2000" },
    { destination: { kind: "burn" }, bps: "1000" },
  ] },
  allocation_plan: {
    curve_meme_bps: "8000",
    lp_meme_bps: "1900",
    lp_quote_bps: "9800",
    protocol_meme_bps: "100",
    protocol_quote_bps: "200",
    recipients: [],
  },
  opening_round_ms: "3600000",
  creation_fee: "1000000000",
  partner_id: COIN_FIXTURE.partnerId,
};

const MIGRATION = {
  cursor: "326100000:2:5:0",
  timestamp_ms: 1_790_230_000_000,
  meme: "190000000000000",
  quote: "2940000000000",
  disposed_meme: "2000000000",
  total_supply_after: "999998000000000",
  pool_key: VENUE_POOL_KEY,
  allocations: [
    {
      cursor: "326100000:2:3:0",
      destination: `0x${"ee".repeat(32)}`,
      meme: "1000000000000",
      quote: "6000000000",
    },
  ],
};

type CurveState = Readonly<{
  memeReserve: string | null;
  quoteReserve: string;
  price: string | null;
  marketCap: string | null;
  pendingBurn: string;
  supply: string;
  traded: boolean;
}>;

const CURVE: Readonly<Record<LaunchLifecycle, CurveState>> = {
  opening_round: {
    memeReserve: null,
    quoteReserve: "0",
    price: null,
    marketCap: null,
    pendingBurn: "0",
    supply: "1000000000000000",
    traded: false,
  },
  live: {
    memeReserve: "696000000000000",
    quoteReserve: "260000000000",
    price: "0.002528735632183908045977011494252873",
    marketCap: "2528730574712",
    pendingBurn: "2000000000",
    supply: "999998000000000",
    traded: true,
  },
  migration_ready: {
    memeReserve: "400000000000000",
    quoteReserve: "3000000000000",
    price: "0.01125",
    marketCap: "11249977500000",
    pendingBurn: "2000000000",
    supply: "999998000000000",
    traded: true,
  },
  migrated: {
    memeReserve: "0",
    quoteReserve: "0",
    price: null,
    marketCap: null,
    pendingBurn: "0",
    supply: "999998000000000",
    traded: true,
  },
};

function curveInputs(lifecycle: LaunchLifecycle) {
  const state = CURVE[lifecycle];
  return {
    virtual_quote: "1500000000000",
    meme_reserve: state.memeReserve,
    quote_reserve: state.quoteReserve,
    graduation_target: "3000000000000",
    sqrt_price_x64: null,
    meme_is_coin_a: null,
    currency_supply: lifecycle === "migrated" ? "999998000000000" : "1000000000000000",
    pending_burn_total: state.pendingBurn,
    balance_0x0: "0",
    meme_decimals: "6",
    quote_decimals: "9",
  };
}

/** The launch facts every curve summary of this launch carries. */
function launchFacts(lifecycle: LaunchLifecycle) {
  return {
    metadata: METADATA,
    created_cursor: "325874009:1:2:0",
    created_at_ms: 1_790_200_000_000,
    launch: LAUNCH_SETTINGS,
    public_start_ms: "1790200000000",
    partner: { partner_id: COIN_FIXTURE.partnerId, status: "admitted", accepted_until_ms: null },
    migration: lifecycle === "migrated" ? MIGRATION : null,
  };
}

/** The curve's pool summary at `lifecycle`. */
export function curvePoolSummary(lifecycle: LaunchLifecycle): Record<string, unknown> {
  const state = CURVE[lifecycle];
  return {
    pool_key: CURVE_POOL_KEY,
    venue: "blast_curve",
    pool_id: COIN_FIXTURE.launchId,
    coin: COIN_FIXTURE.coinType,
    quote: COIN_FIXTURE.quoteType,
    lifecycle,
    ...launchFacts(lifecycle),
    price: state.price,
    market_cap: state.marketCap,
    supply: state.supply,
    inputs: curveInputs(lifecycle),
    windows: state.traded ? withFlow(TRADED_WINDOWS, CURVE_FLOW.traded) : withFlow(QUIET_WINDOWS, CURVE_FLOW.quiet),
    holders: state.traded ? 184 : 0,
    last_trade_cursor: state.traded ? "326074009:3:1:0" : null,
    quote_usd: QUOTE_USD,
  };
}

/** The Bluefin migration pool's summary. */
export function venuePoolSummary(): Record<string, unknown> {
  return {
    pool_key: VENUE_POOL_KEY,
    venue: "bluefin",
    pool_id: COIN_FIXTURE.venuePoolId,
    coin: COIN_FIXTURE.coinType,
    metadata: METADATA,
    quote: COIN_FIXTURE.quoteType,
    lifecycle: "active",
    created_cursor: "326100000:2:6:0",
    created_at_ms: 1_790_230_000_000,
    launch: null,
    public_start_ms: null,
    partner: null,
    migration: null,
    // The pool opens at s = 8 · 2^64 with the Meme as coin B: 2^128 / s² = 1/64.
    price: "0.015625",
    market_cap: "15624968750000",
    supply: "999998000000000",
    inputs: {
      virtual_quote: null,
      meme_reserve: null,
      quote_reserve: null,
      graduation_target: null,
      sqrt_price_x64: "147573952589676412928",
      meme_is_coin_a: false,
      currency_supply: "999998000000000",
      pending_burn_total: "0",
      balance_0x0: "0",
      meme_decimals: "6",
      quote_decimals: "9",
    },
    windows: {
      "5m": window("4000000000", "13.8084", 1, 0),
      "1h": window("9000000000", "31.0689", 2, 1),
      "6h": window("30000000000", "103.563", 5, 2),
      "24h": window("90000000000", "310.689", 12, 6),
      all: window("90000000000", "310.689", 12, 6),
    },
    holders: 212,
    last_trade_cursor: "326274000:1:1:0",
    quote_usd: QUOTE_USD,
  };
}

/** `GET /v1/pools/blast_curve/{launch_id}` at `lifecycle`. */
export function curvePoolBody(lifecycle: LaunchLifecycle, now: number, lagMs?: number): Record<string, unknown> {
  return { provenance: wireProvenance(now, lagMs), pool: curvePoolSummary(lifecycle), candle: null };
}

/** `GET /v1/pools/bluefin/{pool_id}`. */
export function venuePoolBody(now: number, lagMs?: number): Record<string, unknown> {
  return { provenance: wireProvenance(now, lagMs), pool: venuePoolSummary(), candle: null };
}

/** `GET /v1/coins/{coin_type}` at `lifecycle`: after migration its current pool is the venue's. */
export function coinBody(lifecycle: LaunchLifecycle, now: number, lagMs?: number): Record<string, unknown> {
  const migrated = lifecycle === "migrated";
  const current = migrated ? venuePoolSummary() : curvePoolSummary(lifecycle);
  return {
    provenance: wireProvenance(now, lagMs),
    coin: COIN_FIXTURE.coinType,
    launch_id: COIN_FIXTURE.launchId,
    lifecycle,
    ...launchFacts(lifecycle),
    decimals: "6",
    burnable: false,
    sell_burn_bps: "0",
    quote_decimals: "9",
    creator: COIN_FIXTURE.creator,
    creator_source: "address",
    current_pool: migrated ? VENUE_POOL_KEY : CURVE_POOL_KEY,
    pools: migrated ? [CURVE_POOL_KEY, VENUE_POOL_KEY] : [CURVE_POOL_KEY],
    // A coin summary's windows have no flow fields.
    windows: migrated ? current.windows : CURVE[lifecycle].traded ? TRADED_WINDOWS : QUIET_WINDOWS,
    supply: current.supply,
    market_cap: current.market_cap,
    holders: current.holders,
    inputs: current.inputs,
    quote_usd: QUOTE_USD,
  };
}

/** blast-infra's `{"error": …}` body. */
export function errorBody(code: string, message: string): Record<string, unknown> {
  return { error: { code, message } };
}

const SDK_LIFECYCLE: Readonly<Record<LaunchLifecycle, string>> = {
  opening_round: "OpeningRound",
  live: "Live",
  migration_ready: "MigrationReady",
  migrated: "Migrated",
};

export type LaunchObjectOverrides = Readonly<{
  /** The adapter `Witness` type the launch recorded; defaults to this deployment's Bluefin. */
  migrationWitness?: string;
  /** The package whose `launch::Launch` the object is; defaults to this deployment's launchpad. */
  launchpadPackage?: string;
  memeType?: string;
  /** Another launch's object ID (its UID); defaults to the fixture launch. */
  launchId?: string;
  /** The recorded venue tier's tick spacing; defaults to 60 (fee rate 3000). */
  poolTickSpacing?: number;
}>;

/** The launch object as the node stores it at `lifecycle` (SDK `LaunchObject`). */
export function launchObjectFixture(lifecycle: LaunchLifecycle, overrides: LaunchObjectOverrides = {}): LaunchObject {
  const curve = curveInputs(lifecycle);
  const memeType = overrides.memeType ?? COIN_FIXTURE.coinType;
  const zero = 0n;
  const content = launchBcs
    .serialize({
      id: { id: { bytes: overrides.launchId ?? COIN_FIXTURE.launchId } },
      lifecycle: { [SDK_LIFECYCLE[lifecycle]]: true } as never,
      public_start_ms: 1_790_200_000_000n,
      opening_round_ms: 3_600_000n,
      opening_round_bids: 0n,
      opening_round_quote: zero,
      opening_round_meme: zero,
      sell_burn_bps: 0n,
      virtual_quote: BigInt(curve.virtual_quote),
      graduation_target: BigInt(curve.graduation_target),
      quote_fee_bps: 100n,
      meme_fee_bps: 0n,
      venue: normalizeStructTag(overrides.migrationWitness ?? COIN_FIXTURE.migrationWitness),

      lp_fee_split: { routes: [{ destination: { kind: "Owner" }, bps: 5000n }, { destination: { kind: "AutoLp" }, bps: 2000n }, { destination: { kind: "HolderRewards" }, bps: 2000n }, { destination: { kind: "Burn" }, bps: 1000n }] },
      atomic_supply: 1_000_000_000_000_000n,
      meme_reserve: BigInt(curve.meme_reserve ?? "0"),
      real_quote_reserve: BigInt(curve.quote_reserve),
      pending_burn: BigInt(curve.pending_burn_total),
      allocation_plan: {
        curveMemeBps: 8000n,
        lpMemeBps: 1900n,
        lpQuoteBps: 9800n,
        protocolMemeBps: 100n,
        protocolQuoteBps: 200n,
        recipients: [],
      },
      allocated_meme: zero,
      protocol_fees: { packageWitness: `${LAUNCHPAD}::blast_fun::PackageWitness`, origin: overrides.launchId ?? COIN_FIXTURE.launchId, partnerId: COIN_FIXTURE.partnerId, meme: zero, quote: zero, sui: zero },
        creator_meme_fees: zero,
        creator_quote_fees: zero,
      metadata_cap: { id: { id: { bytes: normalizeSuiAddress(`0x${"4d".repeat(32)}`) } } },
      curve_fee_cap_reassignment: { parent: overrides.launchId ?? COIN_FIXTURE.launchId, key: null, delay_ms: 172_800_000n, pending: null },
        creator_metadata_cap_reassignment: { parent: overrides.launchId ?? COIN_FIXTURE.launchId, key: null, delay_ms: 172_800_000n, pending: null },
      creator: null,
      curve_fee_cap_id: null,
      creator_metadata_cap_id: null,
      partner_id: COIN_FIXTURE.partnerId,
    })
    .toBytes();
  return {
    objectId: overrides.launchId ?? COIN_FIXTURE.launchId,
    initialSharedVersion: "5",
    mutable: true,
    type: `${overrides.launchpadPackage ?? LAUNCHPAD}::launch::Launch<${memeType}, ${COIN_FIXTURE.quoteType}>`,
    content,
  };
}

/**
 * A Core API client that serves `objects` (by ID) and nothing else: an
 * absent ID is the node's `notFound`, and `fail` makes every read throw like
 * an unreachable node.
 */
export function fixtureCoreClient(
  objects: (objectId: string) => LaunchObject | null | Promise<LaunchObject | null>,
): ClientWithCoreApi {
  return {
    core: {
      async getObject({ objectId }: Readonly<{ objectId: string }>) {
        const object = await objects(normalizeSuiAddress(objectId));
        if (!object) throw new ObjectError("notFound", `Object ${objectId} does not exist.`, { reason: "notFound", objectId });
        return {
          object: {
            objectId: object.objectId,
            owner: { $kind: "Shared", Shared: { initialSharedVersion: object.initialSharedVersion } },
            type: object.type,
            content: object.content,
          },
        };
      },
    },
  } as unknown as ClientWithCoreApi;
}

/** A launch object as the dev fixture server sends it: its BCS content in base64. */
export function launchObjectWire(object: LaunchObject): Record<string, unknown> {
  return {
    objectId: object.objectId,
    initialSharedVersion: String(object.initialSharedVersion),
    type: object.type,
    content: toBase64(object.content),
  };
}

/**
 * A Core API client over the dev fixture server: launch objects
 * (`/__fixture/objects/{id}`), the chain identifier (`/__fixture/chain`) and
 * transactions (`/__fixture/transactions/{digest}`). A 404 is the node's
 * `notFound`, any other failure an unreachable node.
 */
export function fixtureOriginClient(origin: string, fetcher: typeof fetch = fetch): ClientWithCoreApi {
  async function read(path: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    const response = await fetcher(new URL(path, origin), { cache: "no-store", signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`fixture node answered ${response.status}`);
    return (await response.json()) as Record<string, unknown>;
  }
  const objects = fixtureObjectClient(origin, fetcher);
  const core = {
    ...objects.core,
    async getChainIdentifier(options?: Readonly<{ signal?: AbortSignal }>) {
      const body = await read("/__fixture/chain", options?.signal);
      return { chainIdentifier: String(body?.chainIdentifier) };
    },
    async getTransaction({ digest, signal }: Readonly<{ digest: string; signal?: AbortSignal }>) {
      const wire = await read(`/__fixture/transactions/${encodeURIComponent(digest)}`, signal);
      if (!wire) throw new TransactionError("notFound", digest);
      return outcomeTransactionResult(outcomeTransactionFromWire(wire));
    },
  };
  return { core } as unknown as ClientWithCoreApi;
}

function fixtureObjectClient(origin: string, fetcher: typeof fetch): ClientWithCoreApi {
  return fixtureCoreClient(async (objectId) => {
    const response = await fetcher(new URL(`/__fixture/objects/${objectId}`, origin), { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`fixture node answered ${response.status}`);
    const wire = (await response.json()) as Record<string, string>;
    return {
      objectId: wire.objectId!,
      initialSharedVersion: wire.initialSharedVersion!,
      mutable: true,
      type: wire.type!,
      content: fromBase64(wire.content!),
    };
  });
}
