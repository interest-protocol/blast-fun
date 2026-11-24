import { INDEXED_POOL_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { matchesSchema, contractObject, contractValue, listSchema, ContractViolation, parseCount } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { z } from "zod";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import {
  parseCoinMarket,
  parseOptionalHolders,
  type CoinMarket,
} from "../launchpad-contract/display.ts";
import {
  parseLegacyPublicError,
  type LegacyPublicError,
} from "@blast/core/lib/public-error-messages.ts";
import {
  DISCOVERY_VIEWS,
  LAUNCH_LIFECYCLES,
  type DiscoveryView,
  type LaunchLifecycle,
} from "@blast/core/modules/launchpad-contract/discovery-views.ts";
import {
  parseSections,
  type Section,
} from "@blast/core/modules/launchpad-contract/section.ts";

/**
 * What `GET /api/launchpad/discovery` serves, browser-safe: the views and
 * one page's display rows. Every value is blast-infra's (or the SDK's over
 * blast-infra's raw inputs); a fact it did not serve is null, never zero.
 */

/** T-024's views; Hot is not one. */
export const DISCOVERY_VIEW_NAMES = DISCOVERY_VIEWS;
export type DiscoveryViewName = DiscoveryView;

export type DiscoveryRow = Readonly<{
  /** The launch ID (the curve's object ID); the coin route's key. */
  launchId: string;
  coinType: string;
  quoteType: string;
  lifecycle: LaunchLifecycle;
  /** Coin Registry metadata; null when the coin has none. */
  name: string | null;
  symbol: string | null;
  iconUrl: string | null;
  /** The creation checkpoint's time, Unix ms: New's order. */
  createdAtMs: number;
  /** The `Migrated` checkpoint's time, Unix ms: Graduated's order; null before migration. */
  graduatedAtMs: number | null;
  /** Atomic Quote left to the graduation target (saturating at 0): the `near_graduation` view's order. Null without progress inputs. */
  quoteRemaining: string | null;
  quoteDecimals: number | null;
  /** Progress toward graduation from the SDK, in basis points; null without progress inputs. */
  progressBps: number | null;
  /** The launch partner the launch names, with its indexed status. */
  partner: Readonly<{ partnerId: string; status: "admitted" | "removal_scheduled" | "unknown" }> | null;
  /**
   * R3-23: Blast checked who is behind the coin (`social_coin_trust`). Never on the wire row, whose keys stay
   * strict for open older clients: the parser copies it from the response's `verifiedTeam` list.
   */
  verifiedTeam?: true;
}>;

export type DiscoveryPageData = Readonly<{
  rows: readonly DiscoveryRow[];
  /** The next page's opaque token, or null on the last page. */
  nextCursor: string | null;
}>;

export type DiscoveryMetrics = Readonly<{
  holders: number | null;
  market: CoinMarket | null;
}>;
export type LegacyCoinMarket = Readonly<{
  price?: string;
  totalSupplyAtoms?: string;
  circulatingSupplyAtoms?: string;
  marketCapUsd?: string;
  feeRate?: number;
  description?: string;
}>;

export type LegacyDiscoveryMarket = Readonly<Pick<DiscoveryResponse, "legacyFdvUsd" | "legacyMarket">>;

export type DiscoveryResponse = Readonly<{
  view: DiscoveryViewName;
  featured?: boolean;
  section: Section<DiscoveryPageData>;
  error?: LegacyPublicError;
  metrics?: Readonly<Record<string, DiscoveryMetrics>>;
  /** USD valuations for the curated V1 coins, keyed by coin type. */
  legacyFdvUsd?: Readonly<Record<string, string>>;
  legacyMarket?: Readonly<Record<string, LegacyCoinMarket>>;
  /** R3-23: the launch IDs on this page whose coin Blast verified; absent when none (and from older servers). */
  verifiedTeam?: readonly string[];
}>;

/** What `GET /api/launchpad/wallets/{address}/launches` serves: one page of the wallet's launches as display rows. */
export type WalletLaunchesResponse = Readonly<{ section: Section<DiscoveryPageData>; verifiedTeam?: readonly string[] }>;

const PARTNER_STATUSES = ["admitted", "removal_scheduled", "unknown"];
const ROW_KEYS = [
  "launchId", "coinType", "quoteType", "lifecycle", "name", "symbol", "iconUrl", "createdAtMs",
  "graduatedAtMs", "quoteRemaining", "quoteDecimals", "progressBps", "partner",
];
const ATOMIC = /^(0|[1-9][0-9]{0,39})$/;

function object(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  return contractObject(value, field, keys);
}

function matching(value: unknown, pattern: RegExp, field: string): string {
  return contractValue(z.string().regex(pattern), value, field, "is malformed");
}

function textOrNull(value: unknown, field: string): string | null {
  return contractValue(z.string().nullable(), value, field, "must be a string or null");
}

function countOrNull(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number | null {
  if (value === null) return null;
  const count = parseCount(value, field);
  if (count > max) throw new ContractViolation(field, `is at most ${max}`);
  return count;
}

function parseRow(value: unknown, field: string): DiscoveryRow {
  const row = object(value, field, ROW_KEYS);
  if (!LAUNCH_LIFECYCLES.includes(row.lifecycle as LaunchLifecycle)) throw new ContractViolation(`${field}.lifecycle`, "is unknown");
  let partner: DiscoveryRow["partner"] = null;
  if (row.partner !== null) {
    const raw = object(row.partner, `${field}.partner`, ["partnerId", "status"]);
    if (!PARTNER_STATUSES.includes(raw.status as string)) throw new ContractViolation(`${field}.partner.status`, "is unknown");
    partner = {
      partnerId: matching(raw.partnerId, SUI_OBJECT_ID_PATTERN, `${field}.partner.partnerId`),
      status: raw.status as NonNullable<DiscoveryRow["partner"]>["status"],
    };
  }
  return {
    launchId: matching(row.launchId, SUI_OBJECT_ID_PATTERN, `${field}.launchId`),
    coinType: matching(row.coinType, COIN_TYPE, `${field}.coinType`),
    quoteType: matching(row.quoteType, COIN_TYPE, `${field}.quoteType`),
    lifecycle: row.lifecycle as LaunchLifecycle,
    name: textOrNull(row.name, `${field}.name`),
    symbol: textOrNull(row.symbol, `${field}.symbol`),
    iconUrl: textOrNull(row.iconUrl, `${field}.iconUrl`),
    createdAtMs: parseCount(row.createdAtMs, `${field}.createdAtMs`),
    graduatedAtMs: countOrNull(row.graduatedAtMs, `${field}.graduatedAtMs`),
    quoteRemaining: row.quoteRemaining === null ? null : matching(row.quoteRemaining, ATOMIC, `${field}.quoteRemaining`),
    quoteDecimals: countOrNull(row.quoteDecimals, `${field}.quoteDecimals`, 38),
    progressBps: countOrNull(row.progressBps, `${field}.progressBps`, 10_000),
    partner,
  };
}

function parsePageData(value: unknown): DiscoveryPageData {
  const data = object(value, "data", ["rows", "nextCursor"]);
  if (!matchesSchema(listSchema, data.rows)) throw new ContractViolation("data.rows", "must be a list");
  if (data.nextCursor !== null && (!matchesSchema(z.string().min(1), data.nextCursor))) {
    throw new ContractViolation("data.nextCursor", "must be a page token or null");
  }
  return { rows: data.rows.map((row, index) => parseRow(row, `data.rows[${index}]`)), nextCursor: data.nextCursor };
}

/**
 * A discovery response as the browser receives it. The view must be one of
 * the three; the section parses on its own, and a section that breaks the
 * contract is Unavailable (`contract-violation`), never shown in part.
 */
export function parseDiscoveryResponse(value: unknown): DiscoveryResponse {
  const view = (value as { view?: unknown } | null)?.view;
  if (!DISCOVERY_VIEW_NAMES.includes(view as DiscoveryViewName)) throw new ContractViolation("view", "is not a discovery view");
  const errorValue = (value as { error?: unknown }).error;
  const error =
    errorValue === undefined ? undefined : parseLegacyPublicError(errorValue);
  if (error === null)
    throw new ContractViolation("body.error", "must be a known public error");
  const featured = contractValue(
    z.boolean().optional(),
    (value as { featured?: unknown }).featured,
    "featured",
    "must be a boolean",
  );
  const section = withVerifiedTeam(parseSections(value, { section: parsePageData }).section, value);
  const rawMetrics = (value as { metrics?: Record<string, unknown> }).metrics;
  const metrics: Record<string, DiscoveryMetrics> = {};
  if (
    rawMetrics &&
    typeof rawMetrics === "object" &&
    !Array.isArray(rawMetrics) &&
    (section.state === "available" || section.state === "stale")
  ) {
    for (const row of section.data.rows) {
      const metric = rawMetrics[row.launchId] as
        | { holders?: unknown; market?: unknown }
        | undefined;
      if (metric && typeof metric === "object")
        metrics[row.launchId] = {
          holders: parseOptionalHolders(metric.holders),
          market: parseCoinMarket(metric.market),
        };
    }
  }
  return {
    view: view as DiscoveryViewName,
    section,
    ...(featured === undefined ? {} : { featured }),
    ...(error ? { error } : {}),
    ...(rawMetrics ? { metrics } : {}),
    ...parseLegacyFdv(view, (value as { legacyFdvUsd?: unknown }).legacyFdvUsd),
    ...parseLegacyMarket(view, (value as { legacyMarket?: unknown }).legacyMarket),
  };
}

/**
 * A wallet's launches as the browser receives them: the same rows a discovery view holds, newest
 * first by creation. A section that breaks the contract is Unavailable, never shown in part.
 */
export function parseWalletLaunchesResponse(value: unknown): WalletLaunchesResponse {
  return { section: withVerifiedTeam(parseSections(value, { section: parsePageData }).section, value) };
}

function parseLegacyFdv(view: unknown, value: unknown): Pick<DiscoveryResponse, "legacyFdvUsd"> {
  if (view !== "graduated" || !value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const legacyFdvUsd: Record<string, string> = {};
  for (const { coinType } of INDEXED_POOL_COINS) {
    const fdv = raw[coinType];
    if (typeof fdv === "string" && /^(0|[1-9][0-9]{0,39})\.[0-9]{2}$/.test(fdv)) legacyFdvUsd[coinType] = fdv;
  }
  return Object.keys(legacyFdvUsd).length > 0 ? { legacyFdvUsd } : {};
}

const legacyCoinMarketSchema = z.object({
  price: z.string().regex(/^\d{1,40}(\.\d{1,128})?$/).optional().catch(undefined),
  totalSupplyAtoms: z.string().regex(ATOMIC).optional().catch(undefined),
  circulatingSupplyAtoms: z.string().regex(ATOMIC).optional().catch(undefined),
  marketCapUsd: z.string().regex(/^(0|[1-9][0-9]{0,39})(\.[0-9]{1,192})?$/).optional().catch(undefined),
  feeRate: z.number().int().nonnegative().lt(1_000_000).optional().catch(undefined),
  description: z.string().trim().min(1).max(1024).optional().catch(undefined),
});

function parseLegacyMarket(view: unknown, value: unknown): Pick<DiscoveryResponse, "legacyMarket"> {
  if (view !== "graduated" || !value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const legacyMarket: Record<string, LegacyCoinMarket> = {};
  for (const { coinType } of INDEXED_POOL_COINS) {
    const entry = legacyCoinMarketSchema.safeParse(raw[coinType]);
    if (entry.success) legacyMarket[coinType] = entry.data;
  }
  return { legacyMarket };
}

/** Marks the rows the response's `verifiedTeam` names. The mark is extra: a malformed list marks nothing. */
function withVerifiedTeam(section: Section<DiscoveryPageData>, value: unknown): Section<DiscoveryPageData> {
  const raw = (value as { verifiedTeam?: unknown }).verifiedTeam;
  if (!Array.isArray(raw) || (section.state !== "available" && section.state !== "stale")) return section;
  const verified = new Set(raw.filter((id): id is string => typeof id === "string"));
  if (!section.data.rows.some((row) => verified.has(row.launchId))) return section;
  const rows = section.data.rows.map((row) => (verified.has(row.launchId) ? { ...row, verifiedTeam: true as const } : row));
  return { ...section, data: { ...section.data, rows } };
}
