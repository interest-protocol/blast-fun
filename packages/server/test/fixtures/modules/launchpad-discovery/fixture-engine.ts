import { walletLaunchesCursor } from "@blast/core/modules/launchpad-contract/rewards.ts";
import {
  bondingCursor,
  bondingPosition,
  type BondingSelection,
} from "@blast/core/modules/launchpad-contract/bonding.ts";
import { normalizeBondingSearch } from "@blast/core/modules/launchpad-discovery/bonding.ts";
import {
  CursorError,
  compareKeys,
  decodeCursor,
  encodeCursor,
} from "../../../../../core/src/modules/launchpad-contract/cursor.ts";
import { ContractViolation } from "../../../../../core/src/modules/launchpad-contract/decimal.ts";
import {
  DISCOVERY_CURSORS,
  DISCOVERY_PAGE,
  DISCOVERY_VIEWS,
  discoveryPosition,
  parseLaunchSummary,
  type DiscoveryView,
} from "../../../../../core/src/modules/launchpad-contract/discovery.ts";
import {
  FIXTURE_TIMESTAMP_MS,
  infraProvenanceFixture,
  launchSummaryFixture,
  poolSummaryFixture,
} from "../launchpad-contract/fixtures.ts";
import type { MarketDataDependencies } from "../../../../../core/src/modules/read-routing/market-data.ts";

/**
 * A stand-in for blast-infra's `/v1/pools?view=` over one fixed snapshot,
 * for tests only. It answers with blast-infra's wire
 * shapes, built from the shared contract fixtures, so the real `/v1` client,
 * parser and resource run unchanged. The snapshot spans every lifecycle,
 * duplicate names and tickers, equal creation times, equal Quote remaining,
 * equal migration times (with page boundaries of 10 inside them), a launch
 * without metadata or a first trade, one without a graduation target, and
 * unrelated Cetus and Bluefin pools.
 *
 * It selects and orders rows with the web mirror of the engine's rules
 * (`discoveryPosition`), so it can only agree with blast-infra as far as that
 * mirror does; tests assert hand-worked orders, not this code's.
 */

/** `empty` serves a deployment with no launches yet; the others serve the snapshot or fail as named. */
export const FIXTURE_ENGINE_STATES = [
  "serving",
  "empty",
  "lagging",
  "halted",
  "starting",
  "unreachable",
] as const;
export type FixtureEngineState = (typeof FIXTURE_ENGINE_STATES)[number];

const ORIGIN = "http://blast-infra.fixture";
const SUI =
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const TARGET = "30000000000";
const CHECKPOINT = 130;
/** Checkpoint `n` closed `n` seconds after this. */
const CHECKPOINT_ZERO_MS = FIXTURE_TIMESTAMP_MS - 3_600_000;
const LAG_MS: Readonly<
  Record<"serving" | "empty" | "lagging" | "halted", number>
> = {
  serving: 412,
  empty: 412,
  lagging: 45_000,
  halted: 900_000,
};

const id = (byte: string) => `0x${byte.repeat(32)}`;
const at = (checkpoint: number) => CHECKPOINT_ZERO_MS + checkpoint * 1_000;

/** A pool's trade tape summary: `trades` buys and sells in every window, or none before the first trade. */
function tape(
  trades: number,
  lastTradeCursor: string | null,
): Record<string, unknown> {
  const window = {
    volume_quote: String(trades * 1_000_000_000),
    volume_usd:
      trades === 0 ? null : (trades * 3.39875).toFixed(5).replace(/\.?0+$/, ""),
    buys: trades - Math.floor(trades / 3),
    sells: Math.floor(trades / 3),
    trades,
  };
  return {
    windows: {
      "5m": window,
      "1h": window,
      "6h": window,
      "24h": window,
      all: window,
    },
    holders: trades === 0 ? 1 : 6,
    last_trade_cursor: lastTradeCursor,
    quote_usd: {
      price: "339875000",
      expo: -8,
      publish_time: Math.floor(at(CHECKPOINT) / 1_000),
      age_ms: 1_218,
    },
  };
}

type LaunchSpec = Readonly<{
  byte: string;
  metadata: Readonly<{ name: string; symbol: string }> | null;
  lifecycle: "opening_round" | "live" | "migration_ready" | "migrated";
  /** The `LaunchCreated` position `checkpoint:tx:event`. */
  created: string;
  quoteReserve: string;
  target?: string;
  /** No trade yet: the Meme reserve is unknown. */
  untraded?: boolean;
  /** The `Migrated` position. */
  migrated?: string;
}>;

const LAUNCHES: readonly LaunchSpec[] = [
  {
    byte: "01",
    metadata: { name: "Froggy", symbol: "FROG" },
    lifecycle: "live",
    created: "100:1:0",
    quoteReserve: "25000000000",
  },
  {
    byte: "02",
    metadata: { name: "Froggy", symbol: "FROG" },
    lifecycle: "live",
    created: "100:2:0",
    quoteReserve: "25000000000",
  },
  {
    byte: "03",
    metadata: { name: "Toad", symbol: "TOAD" },
    lifecycle: "migration_ready",
    created: "100:3:1",
    quoteReserve: TARGET,
  },
  {
    byte: "04",
    metadata: { name: "Helmet", symbol: "HELM" },
    lifecycle: "opening_round",
    created: "101:1:0",
    quoteReserve: "0",
  },
  {
    byte: "05",
    metadata: null,
    lifecycle: "live",
    created: "101:2:0",
    quoteReserve: "1000000000",
    untraded: true,
  },
  {
    byte: "06",
    metadata: { name: "Ghost", symbol: "GHOST" },
    lifecycle: "live",
    created: "101:3:0",
    quoteReserve: "0",
    target: "0",
  },
  {
    byte: "07",
    metadata: { name: "Froggy", symbol: "FROG" },
    lifecycle: "migrated",
    created: "99:1:0",
    quoteReserve: TARGET,
    migrated: "120:1:2",
  },
  {
    byte: "08",
    metadata: { name: "Toad", symbol: "TOAD" },
    lifecycle: "migrated",
    created: "99:2:0",
    quoteReserve: TARGET,
    migrated: "120:2:2",
  },
  {
    byte: "09",
    metadata: { name: "Lofi the Yeti", symbol: "LOFI" },
    lifecycle: "migrated",
    created: "98:1:0",
    quoteReserve: TARGET,
    migrated: "110:1:2",
  },
  {
    byte: "0a",
    metadata: { name: "Hippo", symbol: "HIPPO" },
    lifecycle: "live",
    created: "102:1:0",
    quoteReserve: "25000000000",
  },
  {
    byte: "0b",
    metadata: { name: "Moon", symbol: "MOON" },
    lifecycle: "migrated",
    created: "98:0:4",
    quoteReserve: TARGET,
    migrated: "120:0:2",
  },
  // Seven live launches created in one checkpoint, each 5 SUI from graduation like 01, 02 and 0a.
  ...["0c", "0d", "0e", "0f", "10", "11", "12"].map(
    (byte, index): LaunchSpec => ({
      byte,
      metadata: { name: `Pixel ${index + 1}`, symbol: `PX${index + 1}` },
      lifecycle: "live",
      created: `103:${index + 1}:0`,
      quoteReserve: "25000000000",
    }),
  ),
  // Eight launches created in one checkpoint and graduated together in another.
  ...["13", "14", "15", "16", "17", "18", "19", "1a"].map(
    (byte, index): LaunchSpec => ({
      byte,
      metadata: { name: `Comet ${index + 1}`, symbol: `CMT${index + 1}` },
      lifecycle: "migrated",
      created: `97:${index + 1}:0`,
      quoteReserve: TARGET,
      migrated: `125:${index + 1}:2`,
    }),
  ),
];

function launchRow(spec: LaunchSpec): Record<string, unknown> {
  const base = launchSummaryFixture();
  const inputs = base.inputs as Record<string, unknown>;
  const launch = base.launch as Record<string, unknown>;
  const launchId = id(spec.byte);
  const coin = `0x${spec.byte.repeat(31)}ff::meme::MEME`;
  const migrated = spec.migrated
    ? {
        cursor: `${spec.migrated}:0`,
        timestamp_ms: at(Number(spec.migrated.split(":")[0])),
        meme: "190000000000000",
        quote: "26700000000",
        disposed_meme: "175000000065659",
        total_supply_after: "1000000000000000",
        pool_key: null,
        allocations: [],
      }
    : null;
  return {
    ...base,
    pool_key: `blast_curve:${launchId}`,
    pool_id: launchId,
    coin,
    quote: SUI,
    lifecycle: spec.lifecycle,
    metadata: spec.metadata
      ? {
          ...spec.metadata,
          description: `${spec.metadata.name} fixture launch`,
          icon_url: "",
        }
      : null,
    created_cursor: `${spec.created}:0`,
    created_at_ms: at(Number(spec.created.split(":")[0])),
    launch: { ...launch, partner_id: null },
    partner: null,
    migration: migrated,
    ...tape(
      spec.untraded ? 0 : 3,
      spec.untraded ? null : `${spec.created.split(":")[0]}:9:0:0`,
    ),
    price: spec.untraded ? null : base.price,
    market_cap: spec.untraded ? null : base.market_cap,
    inputs: {
      ...inputs,
      quote_reserve: spec.quoteReserve,
      graduation_target: spec.target ?? TARGET,
      meme_reserve: spec.untraded ? null : inputs.meme_reserve,
    },
  };
}

/** Unrelated Sui pools the engine also indexes: never Blast launches, never in a view. */
function venuePool(
  venue: "cetus" | "bluefin",
  byte: string,
): Record<string, unknown> {
  const base = poolSummaryFixture();
  return {
    ...base,
    ...tape(12, "125:1:0:0"),
    pool_key: `${venue}:${id(byte)}`,
    venue,
    pool_id: id(byte),
    coin: `0x${byte.repeat(31)}ee::suiman::SUIMAN`,
    inputs: {
      ...(base.inputs as Record<string, unknown>),
      virtual_quote: null,
      meme_reserve: null,
      quote_reserve: null,
      graduation_target: null,
      sqrt_price_x64: "18446744073709551616",
      meme_is_coin_a: true,
    },
  };
}

/** The snapshot every page is read from, as blast-infra holds it: launches and unrelated pools. */
export function discoveryFixtureSnapshot(): Record<string, unknown>[] {
  return [
    ...LAUNCHES.map(launchRow),
    venuePool("cetus", "c1"),
    venuePool("bluefin", "b1"),
  ];
}

const ASCENDING: Readonly<Record<DiscoveryView, boolean>> = {
  new: false,
  near_graduation: true,
  graduated: false,
};

function refusal(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** The view's rows in its order with their places; anything not a launch in the view is left out. */
function listed(
  view: DiscoveryView,
  snapshot: readonly Record<string, unknown>[],
) {
  const shape = DISCOVERY_CURSORS[view];
  const rows = snapshot.flatMap((row) => {
    try {
      const place = discoveryPosition(view, parseLaunchSummary(row));
      return place ? [{ row, place }] : [];
    } catch (error) {
      if (error instanceof ContractViolation) return [];
      throw error;
    }
  });
  return rows.sort(
    (a, b) => (ASCENDING[view] ? 1 : -1) * compareKeys(shape, a.place, b.place),
  );
}

function pools(
  url: URL,
  provenance: Record<string, unknown>,
  snapshot: readonly Record<string, unknown>[],
): Response {
  const view = url.searchParams.get("view") as DiscoveryView;
  if (!DISCOVERY_VIEWS.includes(view))
    return refusal(400, "invalid_parameter", "view is required here");
  const rawLimit =
    url.searchParams.get("limit") ?? String(DISCOVERY_PAGE.default);
  const limit = /^[0-9]{1,3}$/.test(rawLimit) ? Number(rawLimit) : 0;
  if (limit < 1 || limit > DISCOVERY_PAGE.max)
    return refusal(400, "invalid_parameter", "limit out of range");
  const shape = DISCOVERY_CURSORS[view];
  let rows = listed(view, snapshot);
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) {
    try {
      const after = decodeCursor(cursor, shape);
      rows = rows.filter(
        ({ place }) =>
          (ASCENDING[view] ? 1 : -1) * compareKeys(shape, place, after) > 0,
      );
    } catch (error) {
      if (error instanceof CursorError)
        return refusal(
          400,
          "invalid_parameter",
          "cursor is not a page token of this view",
        );
      throw error;
    }
  }
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > limit && last
      ? encodeCursor(shape, last.place.key, last.place.tie)
      : null;
  return Response.json({
    provenance,
    pools: page.map(({ row }) => row),
    next_cursor: nextCursor,
  });
}

function walletLaunches(
  url: URL,
  provenance: Record<string, unknown>,
  snapshot: readonly Record<string, unknown>[],
): Response {
  const address = url.pathname.split("/")[3]!;
  const shape = walletLaunchesCursor(address);
  let rows =
    address === `0x${"a1".repeat(32)}`
      ? snapshot
          .filter((row) => row.venue === "blast_curve")
          .map((row) => ({
            row,
            place: {
              key: [],
              tie: String(row.created_cursor)
                .split(":")
                .slice(0, 3)
                .map((v) => v.padStart(20, "0")),
            },
          }))
          .sort((a, b) => -compareKeys(shape, a.place, b.place))
      : [];
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    const after = decodeCursor(cursor, shape);
    rows = rows.filter(({ place }) => compareKeys(shape, place, after) < 0);
  }
  const limit = Number(url.searchParams.get("limit") ?? 25),
    page = rows.slice(0, limit),
    last = page.at(-1);
  return Response.json({
    address,
    provenance,
    launches: page.map(({ row }) => row),
    next_cursor:
      rows.length > limit && last
        ? encodeCursor(shape, last.place.key, last.place.tie)
        : null,
  });
}

/** Test-only catalog responder. Real SQL ordering/matching has independent PostgreSQL coverage. */
function bonding(
  url: URL,
  provenance: Record<string, unknown>,
  snapshot: readonly Record<string, unknown>[],
): Response {
  const selection = {
    stage: url.searchParams.get("stage"),
    sort: url.searchParams.get("sort"),
    q: url.searchParams.get("q") ?? "",
    ...(url.searchParams.has("creator")
      ? { creator: url.searchParams.get("creator")! }
      : {}),
    ...(url.searchParams.has("account_commitment")
      ? { accountCommitment: url.searchParams.get("account_commitment")! }
      : {}),
  } as BondingSelection;
  const shape = bondingCursor(selection);
  let rows = snapshot
    .flatMap((row) => {
      try {
        const launch = parseLaunchSummary(row);
        const place = bondingPosition(selection, launch);
        const term = normalizeBondingSearch(selection.q) ?? "";
        const matches =
          !term ||
          [launch.metadata?.name, launch.metadata?.symbol].some((v) =>
            normalizeBondingSearch(v ?? "")?.includes(term),
          ) ||
          launch.launchId === term ||
          launch.coinType === term;
        const creatorMatches =
          !selection.creator || selection.creator === `0x${"a1".repeat(32)}`;
        return place && matches && creatorMatches ? [{ row, place }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => -compareKeys(shape, a.place, b.place));
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    const after = decodeCursor(cursor, shape);
    rows = rows.filter(({ place }) => compareKeys(shape, place, after) < 0);
  }
  const limit = Number(url.searchParams.get("limit") ?? 25);
  const page = rows.slice(0, limit),
    last = page.at(-1);
  return Response.json({
    provenance,
    pools: page.map(({ row }) => row),
    next_cursor:
      rows.length > limit && last
        ? encodeCursor(shape, last.place.key, last.place.tie)
        : null,
  });
}

/** `/v1` dependencies answering from the fixture snapshot in `state()`, read on every request. */
export function discoveryFixtureEngine(
  options: Readonly<{ state: () => FixtureEngineState; now?: () => number }>,
): MarketDataDependencies {
  const now = options.now ?? Date.now;
  return {
    origin: ORIGIN,
    now,
    timeoutMs: 1_000,
    statusCacheMs: 0,
    expected: null,
    fetch: async (input: string | URL | Request) => {
      const state = options.state();
      if (state === "unreachable") throw new TypeError("fetch failed");
      if (state === "starting")
        return refusal(503, "not_ready", "The engine has not bootstrapped.");
      const observed = now();
      const lag = LAG_MS[state];
      const provenance = infraProvenanceFixture({
        network: "localnet",
        checkpoint: CHECKPOINT,
        timestamp_ms: observed - lag,
        observed_ms: observed,
        lag_ms: lag,
      });
      const url = new URL(String(input));
      if (url.pathname === "/v1/status") return Response.json({ provenance });
      const snapshot = state === "empty" ? [] : discoveryFixtureSnapshot();
      if (/^\/v1\/wallets\/[^/]+\/launches$/.test(url.pathname))
        return walletLaunches(url, provenance, snapshot);
      if (url.pathname === "/v1/bonding")
        return bonding(url, provenance, snapshot);
      if (url.pathname === "/v1/pools")
        return pools(url, provenance, snapshot);
      const pool = snapshot.find((row) => url.pathname === `/v1/pools/${row.venue}/${row.pool_id}`);
      return pool ? Response.json({ provenance, pool }) : refusal(404, "not_found", "unknown route");
    },
  };
}
