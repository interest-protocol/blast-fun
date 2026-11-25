import { matchesSchema, listSchema, contractValue, recordSchema, ContractViolation, parseAtomic, parseCount } from "./decimal.ts";
import { z } from "zod";
import {
  parseCoinMarket,
  parseOptionalHolders,
  type CoinMarket,
} from "./display.ts";
import {
  launchProgressBps as sdkLaunchProgressBps,
  type LaunchLifecycle as SdkLifecycle,
} from "@interest-protocol/blast-sdk/launchpad";

import type { MarketDataDependencies } from "../read-routing/market-data.ts";
import { parseOpeningRound, type OpeningRound } from "./activity.ts";
import { CursorError, EVENT_CURSOR, compareKeys, decodeCursor, type CursorPosition, type CursorShape } from "./cursor.ts";
import { DISCOVERY_VIEWS, LAUNCH_LIFECYCLES, quoteRemaining, type DiscoveryView, type LaunchLifecycle } from "./discovery-views.ts";
import type { RoutedRead } from "./read.ts";
import { walletLaunchesCursor, walletLaunchesPath } from "./rewards.ts";
import { parseMarketEconomics, readV1, type MarketEconomics, type V1Answer } from "./v1.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The core launch reads of blast-infra's `GET /v1/pools?view=…` (its
 * docs/api.md "Discovery views"): Blast launch curves with their identity,
 * lifecycle and launch facts, in one of three exact orders, a page at a time.
 *
 * - `new`: every launch, by creation checkpoint time, newest first; ties by
 *   the `LaunchCreated` position, newest first. The core launch collection.
 * - `near_graduation`: `live` and `migration_ready` launches with progress
 *   inputs, by atomic Quote remaining (saturating at 0), least first; ties by
 *   the `LaunchCreated` position, oldest first.
 * - `graduated`: `migrated` launches, by `Migrated` checkpoint time, newest
 *   first; ties by the `Migrated` position, newest first.
 *
 * Page tokens are the shared cursor envelope (`cursor.ts`): the view's key,
 * then the native position `(checkpoint, tx_slot, event_slot)`, each part a
 * 20-digit zero-padded decimal so string order is numeric order. A page is
 * checked against its view before any projection uses it: a row outside the
 * view, out of order, or a next cursor that is not its last row's place makes
 * the whole answer a contract violation (Unavailable), never a reordered or
 * partial list. Display economics stay blast-infra's; progress comes from the
 * SDK over the raw inputs. The Next.js discovery resource builds on this.
 *
 * The view rules here (`discoveryPosition`, the directions, `DISCOVERY_CURSORS`)
 * mirror blast-infra `src/registry/discovery.rs` (`place`, `View::ascending`,
 * `token`) at `lst/T-024-1@a0bd33d`; a rule change lands on both hosts
 * together. `fixtures/v1-discovery-<view>.json` are pages that engine served
 * over its curve fixture (its `capture_discovery_pages` test), which these
 * parsers must accept. blast-infra serves each page from one memory snapshot
 * and names that snapshot's checkpoint in `provenance`, so a page always
 * agrees with itself.
 */

export { DISCOVERY_VIEWS, LAUNCH_LIFECYCLES, quoteRemaining, type DiscoveryView, type LaunchLifecycle };

/** Each view's page-token shape, as blast-infra writes it. */
export const DISCOVERY_CURSORS: Readonly<Record<DiscoveryView, CursorShape>> = {
  new: { scope: "pools:new", key: ["integer"], tie: 3 },
  near_graduation: { scope: "pools:near_graduation", key: ["decimal"], tie: 3 },
  graduated: { scope: "pools:graduated", key: ["integer"], tie: 3 },
};

/**
 * blast-infra's default page bounds (`DISCOVERY_PAGE_DEFAULT`, `DISCOVERY_PAGE_MAX`).
 * They must match the engine's configuration: a deployment that changes them
 * there passes its own bounds to `discoveryPath`, or the engine refuses a
 * limit this side admits (a `refused` 400 answer instead of a local
 * `LAUNCHPAD_CURSOR_INVALID`).
 */
export const DISCOVERY_PAGE: Readonly<{ default: number; max: number }> = { default: 25, max: 100 };

/** The most rows one `pools` body may hold. */
const PAGE_CEILING = 100;
const POSITION_WIDTH = 20;
const ASCENDING: Readonly<Record<DiscoveryView, boolean>> = { new: false, near_graduation: true, graduated: false };

const SDK_LIFECYCLE: Readonly<Record<LaunchLifecycle, SdkLifecycle>> = {
  opening_round: "OpeningRound",
  live: "Live",
  migration_ready: "MigrationReady",
  migrated: "Migrated",
};

export type CoinMetadata = Readonly<{ name: string; symbol: string; description: string; iconUrl: string }>;

/** The immutable `LaunchCreated` settings a launch read carries (the fee and allocation plans stay raw). */
export type LaunchSettings = Readonly<{
  migrationWitness: string;
  poolTickSpacing: bigint | null;
  poolFeeRate: bigint | null;
  openingRoundMs: bigint;
  creationFee: bigint;
  partnerId: string | null;
  lpFeeSplit: unknown;
  allocationPlan: unknown;
}>;

/** The partner a launch names: `unknown` when no partner event of it was indexed. */
export type LaunchPartner = Readonly<{
  partnerId: string;
  status: "admitted" | "removal_scheduled" | "unknown";
  /** A scheduled removal's deadline for new launches, Unix ms; null otherwise. */
  acceptedUntilMs: bigint | null;
}>;

export type MigrationAllocation = Readonly<{ cursor: string; destination: string; meme: bigint; quote: bigint }>;

/** A launch's `Migrated`, with the allocation payments before it. */
export type LaunchMigration = Readonly<{
  cursor: string;
  timestampMs: number;
  meme: bigint;
  quote: bigint;
  disposedMeme: bigint;
  totalSupplyAfter: bigint;
  /** The coin's venue pool, when the migration opened one blast-infra tracks. */
  poolKey: string | null;
  allocations: readonly MigrationAllocation[];
}>;

/** A Blast launch curve as a launch read serves it. Unavailable facts are null, never zero. */
export type LaunchSummary = Readonly<{
  poolKey: string;
  launchId: string;
  coinType: string;
  quoteType: string;
  lifecycle: LaunchLifecycle;
  createdCursor: string;
  createdAtMs: number;
  metadata: CoinMetadata | null;
  launch: LaunchSettings;
  publicStartMs: bigint | null;
  partner: LaunchPartner | null;
  migration: LaunchMigration | null;
  /** The launch's opening round (`activity.ts`); null without one, or when the answer predates the field. */
  openingRound: OpeningRound | null;
  economics: MarketEconomics;
  holders?: number | null;
  market?: CoinMarket | null;
}>;

export type DiscoveryPage = Readonly<{
  view: DiscoveryView;
  launches: readonly LaunchSummary[];
  /** The next page's `cursor`, or null on the last page. */
  nextCursor: string | null;
}>;

function record(value: unknown, field: string): Record<string, unknown> {
  return contractValue(recordSchema, value, field, "must be an object");
}

function matching(value: unknown, pattern: RegExp, field: string, what: string): string {
  return contractValue(z.string().regex(pattern), value, field, `must be ${what}`);
}

function text(value: unknown, field: string): string {
  return contractValue(z.string(), value, field, "must be a string");
}

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function parseMetadata(value: unknown, field: string): CoinMetadata {
  const metadata = record(value, field);
  return {
    name: text(metadata.name, `${field}.name`),
    symbol: text(metadata.symbol, `${field}.symbol`),
    description: text(metadata.description, `${field}.description`),
    iconUrl: text(metadata.icon_url, `${field}.icon_url`),
  };
}

function parseSettings(value: unknown, field: string): LaunchSettings {
  const settings = record(value, field);
  const atomic = (key: string) => parseAtomic(settings[key], `${field}.${key}`, 64);
  const tier = settings.pool_tier === null || settings.pool_tier === undefined ? null : record(settings.pool_tier, `${field}.pool_tier`);
  return {
    migrationWitness: text(settings.venue, `${field}.venue`),
    poolTickSpacing: tier && parseAtomic(tier.tick_spacing, `${field}.pool_tier.tick_spacing`, 64),
    poolFeeRate: tier && nullable(tier.fee_rate, (value) => parseAtomic(value, `${field}.pool_tier.fee_rate`, 64)),
    openingRoundMs: atomic("opening_round_ms"),
    creationFee: atomic("creation_fee"),
    partnerId: nullable(settings.partner_id, (id) => matching(id, SUI_OBJECT_ID_PATTERN, `${field}.partner_id`, "an object id")),
    lpFeeSplit: record(settings.lp_fee_split, `${field}.lp_fee_split`),
    allocationPlan: record(settings.allocation_plan, `${field}.allocation_plan`),
  };
}

const PARTNER_STATUSES = ["admitted", "removal_scheduled", "unknown"] as const;

function parsePartner(value: unknown, field: string): LaunchPartner {
  const partner = record(value, field);
  const status = partner.status as LaunchPartner["status"];
  if (!matchesSchema(z.enum(PARTNER_STATUSES), status)) throw new ContractViolation(`${field}.status`, "is unknown");
  const acceptedUntilMs = nullable(partner.accepted_until_ms, (ms) => parseAtomic(ms, `${field}.accepted_until_ms`, 64));
  if ((status === "removal_scheduled") !== (acceptedUntilMs !== null)) {
    throw new ContractViolation(`${field}.accepted_until_ms`, "is set exactly when a removal is scheduled");
  }
  return { partnerId: matching(partner.partner_id, SUI_OBJECT_ID_PATTERN, `${field}.partner_id`, "an object id"), status, acceptedUntilMs };
}

function parseMigration(value: unknown, field: string): LaunchMigration {
  const migration = record(value, field);
  const atomic = (key: string) => parseAtomic(migration[key], `${field}.${key}`, 64);
  const allocations = migration.allocations;
  if (!matchesSchema(listSchema, allocations)) throw new ContractViolation(`${field}.allocations`, "must be a list");
  return {
    cursor: matching(migration.cursor, EVENT_CURSOR, `${field}.cursor`, "a cursor"),
    timestampMs: parseCount(migration.timestamp_ms, `${field}.timestamp_ms`),
    meme: atomic("meme"),
    quote: atomic("quote"),
    disposedMeme: atomic("disposed_meme"),
    totalSupplyAfter: atomic("total_supply_after"),
    poolKey: nullable(migration.pool_key, (key) => text(key, `${field}.pool_key`)),
    allocations: allocations.map((item, index) => {
      const at = `${field}.allocations[${index}]`;
      const paid = record(item, at);
      return {
        cursor: matching(paid.cursor, EVENT_CURSOR, `${at}.cursor`, "a cursor"),
        destination: matching(paid.destination, SUI_OBJECT_ID_PATTERN, `${at}.destination`, "an address"),
        meme: parseAtomic(paid.meme, `${at}.meme`, 64),
        quote: parseAtomic(paid.quote, `${at}.quote`, 64),
      };
    }),
  };
}

/** A Blast launch curve's summary; a venue pool or a broken field is a contract violation. */
export function parseLaunchSummary(value: unknown, field = "pool"): LaunchSummary {
  const summary = record(value, field);
  if (summary.venue !== "blast_curve") throw new ContractViolation(`${field}.venue`, "must be blast_curve for a launch");
  const economics = parseMarketEconomics(summary, field);
  const launchId = matching(summary.pool_id, SUI_OBJECT_ID_PATTERN, `${field}.pool_id`, "an object id");
  if (summary.pool_key !== `blast_curve:${launchId}`) {
    throw new ContractViolation(`${field}.pool_key`, "must name the launch's curve");
  }
  const lifecycle = summary.lifecycle as LaunchLifecycle;
  if (!matchesSchema(z.enum(LAUNCH_LIFECYCLES), lifecycle)) throw new ContractViolation(`${field}.lifecycle`, "is not a launch lifecycle");
  const launch = parseSettings(summary.launch, `${field}.launch`);
  const partner = nullable(summary.partner, (value) => parsePartner(value, `${field}.partner`));
  if ((partner?.partnerId ?? null) !== launch.partnerId) {
    throw new ContractViolation(`${field}.partner`, "must be the partner the launch names");
  }
  const migration = nullable(summary.migration, (value) => parseMigration(value, `${field}.migration`));
  if (migration !== null && lifecycle !== "migrated") {
    throw new ContractViolation(`${field}.migration`, "is only on a migrated launch");
  }
  return {
    poolKey: summary.pool_key,
    launchId,
    coinType: matching(summary.coin, COIN_TYPE, `${field}.coin`, "a coin type"),
    quoteType: matching(summary.quote, COIN_TYPE, `${field}.quote`, "a coin type"),
    lifecycle,
    createdCursor: matching(summary.created_cursor, EVENT_CURSOR, `${field}.created_cursor`, "a cursor"),
    createdAtMs: parseCount(summary.created_at_ms, `${field}.created_at_ms`),
    metadata: nullable(summary.metadata, (value) => parseMetadata(value, `${field}.metadata`)),
    launch,
    publicStartMs: nullable(summary.public_start_ms, (ms) => parseAtomic(ms, `${field}.public_start_ms`, 64)),
    partner,
    migration,
    openingRound:
      "opening_round" in summary
        ? nullable(summary.opening_round, (value) => parseOpeningRound(value, `${field}.opening_round`))
        : null,
    economics,
    holders: parseOptionalHolders(summary.holders),
    market: parseCoinMarket(summary.market),
  };
}

/** A curve's progress toward graduation in basis points, from the SDK over its raw inputs. */
export function launchProgressBps(launch: LaunchSummary): bigint {
  const { quoteReserve, graduationTarget } = launch.economics.inputs;
  // Narrows the types only: a parsed blast_curve summary always has both (v1.ts checkVenueShape).
  if (quoteReserve === null || graduationTarget === null) {
    throw new ContractViolation("inputs", "a curve has its Quote reserve and graduation target");
  }
  return curveProgressBps(launch.lifecycle, quoteReserve, graduationTarget);
}

/**
 * The SDK's progress in basis points over a curve's lifecycle and raw atoms:
 * 10,000 once it is ready to migrate or migrated, else its reserve over its
 * target, capped. The target must be positive.
 */
export function curveProgressBps(lifecycle: LaunchLifecycle, quoteReserve: bigint, graduationTarget: bigint): bigint {
  return sdkLaunchProgressBps({ realQuoteReserve: quoteReserve, graduationTarget, lifecycle: SDK_LIFECYCLE[lifecycle] });
}

/** A native position `c:t:e:p` as the three zero-padded tie-break parts. */
function positionTie(cursor: string): string[] {
  return cursor.split(":").slice(0, 3).map((part) => part.padStart(POSITION_WIDTH, "0"));
}

/** The launch's place in `view`, or null when the view does not list it. */
export function discoveryPosition(view: DiscoveryView, launch: LaunchSummary): CursorPosition | null {
  switch (view) {
    case "new":
      return { key: [launch.createdAtMs], tie: positionTie(launch.createdCursor) };
    case "near_graduation": {
      const { quoteReserve, graduationTarget } = launch.economics.inputs;
      const listed = launch.lifecycle === "live" || launch.lifecycle === "migration_ready";
      if (!listed || quoteReserve === null || graduationTarget === null || graduationTarget === 0n) return null;
      return { key: [quoteRemaining(quoteReserve, graduationTarget).toString()], tie: positionTie(launch.createdCursor) };
    }
    case "graduated":
      if (launch.lifecycle !== "migrated" || launch.migration === null) return null;
      return { key: [launch.migration.timestampMs], tie: positionTie(launch.migration.cursor) };
  }
}

/**
 * A validated `/v1/pools?view=` body: every row is in the view, rows are in
 * its exact order with distinct places, and a next cursor is the last row's
 * place in the view's envelope.
 */
export function parseDiscoveryPage(view: DiscoveryView, body: unknown): DiscoveryPage {
  const shape = DISCOVERY_CURSORS[view];
  const answer = record(body, "body");
  const pools = answer.pools;
  if (!matchesSchema(listSchema, pools)) throw new ContractViolation("pools", "must be a list");
  if (pools.length > PAGE_CEILING) throw new ContractViolation("pools", `holds at most ${PAGE_CEILING} rows`);
  const launches = pools.map((row, index) => parseLaunchSummary(row, `pools[${index}]`));
  const places = launches.map((launch, index) => {
    const place = discoveryPosition(view, launch);
    if (!place) throw new ContractViolation(`pools[${index}]`, `is not in the ${view} view`);
    return place;
  });
  places.slice(1).forEach((place, index) => {
    const order = compareKeys(shape, places[index], place);
    if (ASCENDING[view] ? order >= 0 : order <= 0) {
      throw new ContractViolation(`pools[${index + 1}]`, `is out of the ${view} order`);
    }
  });
  const nextCursor = nullable(answer.next_cursor, (token) => text(token, "next_cursor"));
  if (nextCursor !== null) {
    let after: CursorPosition;
    try {
      after = decodeCursor(nextCursor, shape);
    } catch (error) {
      if (error instanceof CursorError) throw new ContractViolation("next_cursor", error.message);
      throw error;
    }
    const last = places.at(-1);
    if (!last || compareKeys(shape, last, after) !== 0) {
      throw new ContractViolation("next_cursor", "must be the page's last place");
    }
  }
  return { view, launches, nextCursor };
}

export type DiscoveryRequest = Readonly<{
  limit?: string | null;
  cursor?: string | null;
  excludeQuote?: string;
}>;

/**
 * The `/v1/pools` path of a view's page: `limit` is a whole number from 1 to
 * `bounds.max` (default `bounds.default`), refused otherwise rather than
 * clamped; `cursor` must be a token of this view. A refusal is a CursorError
 * (`LAUNCHPAD_CURSOR_INVALID`, 400).
 */
export function discoveryPath(
  view: DiscoveryView,
  request: DiscoveryRequest,
  bounds: Readonly<{ default: number; max: number }> = DISCOVERY_PAGE,
): string {
  let limit = bounds.default;
  if (request.limit !== undefined && request.limit !== null) {
    const raw = request.limit;
    limit = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : 0;
    if (limit < 1 || limit > bounds.max) throw new CursorError(`limit must be a whole number from 1 to ${bounds.max}`);
  }
  const params = new URLSearchParams({ view, limit: String(limit) });
  if (request.excludeQuote) params.set("exclude_quote", request.excludeQuote);
  if (request.cursor !== undefined && request.cursor !== null) {
    decodeCursor(request.cursor, DISCOVERY_CURSORS[view]);
    params.set("cursor", request.cursor);
  }
  return `/v1/pools?${params.toString()}`;
}

/** Reads one page of a view from blast-infra, validated, with its provenance. */
export function readDiscoveryPage(
  view: DiscoveryView,
  request: DiscoveryRequest,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<DiscoveryPage>>> {
  return readV1(
    "discovery-market-facts",
    discoveryPath(view, request),
    (body) => parseDiscoveryPage(view, body),
    dependencies,
  );
}

// --- A wallet's launches -----------------------------------------------------------------------------

export type WalletLaunchesPage = Readonly<{
  address: string;
  launches: readonly LaunchSummary[];
  /** The next page's `cursor`, or null on the last page. */
  nextCursor: string | null;
}>;

/**
 * A validated `GET /v1/wallets/{address}/launches` body: discovery rows, newest first by creation
 * position, each once, and a next cursor that is the last row's position in the list's envelope.
 */
export function parseWalletLaunchesPage(address: string, body: unknown): WalletLaunchesPage {
  const shape = walletLaunchesCursor(address);
  const answer = record(body, "body");
  if (answer.address !== address) throw new ContractViolation("address", "must be the requested wallet");
  const rows = answer.launches;
  if (!Array.isArray(rows)) throw new ContractViolation("launches", "must be a list");
  if (rows.length > PAGE_CEILING) throw new ContractViolation("launches", `holds at most ${PAGE_CEILING} rows`);
  const launches = rows.map((row, index) => parseLaunchSummary(row, `launches[${index}]`));
  const places = launches.map((launch) => ({ key: [], tie: positionTie(launch.createdCursor) }));
  places.slice(1).forEach((place, index) => {
    if (compareKeys(shape, places[index], place) <= 0) throw new ContractViolation(`launches[${index + 1}]`, "is out of creation order");
  });
  const nextCursor = nullable(answer.next_cursor, (token) => text(token, "next_cursor"));
  if (nextCursor !== null) {
    let after: CursorPosition;
    try {
      after = decodeCursor(nextCursor, shape);
    } catch (error) {
      if (error instanceof CursorError) throw new ContractViolation("next_cursor", error.message);
      throw error;
    }
    const last = places.at(-1);
    if (!last || compareKeys(shape, last, after) !== 0) throw new ContractViolation("next_cursor", "must be the page's last place");
  }
  return { address, launches, nextCursor };
}

/** Reads one page of the launches `address` created from blast-infra, validated, with its provenance. */
export function readWalletLaunchesPage(
  address: string,
  request: DiscoveryRequest,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<V1Answer<WalletLaunchesPage>>> {
  return readV1(
    "discovery-market-facts",
    walletLaunchesPath(address, request),
    (body) => parseWalletLaunchesPage(address, body),
    dependencies,
  );
}
