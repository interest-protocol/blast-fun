import { displayPriceOf } from "@blast/core/modules/social/prices/test-sui.ts";
import { z } from "zod";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  PRESALE_LIST_MAX_LIMIT,
  PRESALE_LIST_STATUSES,
  type PresaleListSort,
  type PresaleListStatus,
  type PresaleListTrustFilter,
  type PresaleStatusCounts,
  type SocialPresaleSummary,
} from "@blast/core/modules/social/contracts/presales.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { Params, quoteAtParSql, quoteUsdSql, usdSql } from "@blast/core/modules/social/presales/sql.ts";
import { PUBLIC_PRESALES, SHOWN_PRESALES, closedSaleSql, liveSaleSql, presalePhase, upcomingSaleSql } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { hasSaleMetadata } from "@blast/core/modules/social/contracts/sales.ts";
import { SALE_METADATA_COLUMNS, saleMetadataJoinSql, saleMetadataOf, type SaleMetadataRow } from "@blast/server/modules/social/sales/store.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { PRESALE_PAR_QUOTE_TYPES } from "@blast/core/modules/social/contracts/create.ts";

/**
 * One row per presale with everything a list row shows, from
 * `chain_read_v1.presales` and its lifecycle log, positions and prices, plus
 * the sale's follower count (interest), its trust flags (R3-23, the two
 * booleans of `social_sale_trust` only) and its public details
 * (`social_sale_metadata`, R3-24, one primary-key probe). The presale price of a trading sale
 * comes from its claims: what buyers paid over the tokens they received (one
 * price for every buyer, so a sample of 50 claims is exact up to rounding).
 */
export type SummaryRow = SaleMetadataRow & Readonly<{
  presale_id: string;
  name: string;
  symbol: string;
  icon_url: string;
  lifecycle: string;
  start_ms: string;
  end_ms: string;
  venue: string;
  participants: string;
  sale_token: string;
  sale_decimals: number;
  quote_symbol: string;
  quote_type: string;
  raise_target: string;
  total_commitments: string;
  quote_decimals: number;
  stable: boolean;
  target_usd: string | null;
  raised_usd: string | null;
  allowlisted: boolean;
  min_commitment_usd: string | null;
  wallet_cap_usd: string | null;
  /** R3-40: the same two limits in quote atoms (null as their USD would be for an allowlisted sale / no cap). */
  min_commitment_atoms: string | null;
  wallet_cap_atoms: string | null;
  opened_ms: string | null;
  funded_ms: string | null;
  migrated_ms: string | null;
  cancelled_ms: string | null;
  interested: number;
  claimed_price_usd: string | null;
  /** R3-40: what buyers paid per whole token in the quote coin, from the same claims; null before the first. */
  claimed_price_quote: string | null;
  price_usd: string | null;
  verified_team: boolean;
  audited: boolean;
  sort_key: string | null;
}>;

type Join = "prices" | "lifecycle" | "interest" | "claims" | "trust" | "pin";

/** The joins a summary row (or a sort key) may need, by name (`p` is the presale). */
function joinSql(join: Join): string {
  switch (join) {
    case "prices":
      return `LEFT JOIN ${displayPriceOf("p.quote_type")} qp ON TRUE
  LEFT JOIN ${displayPriceOf("p.sale_token", "p.lifecycle = 'migrated'")} sp ON TRUE`;
    case "lifecycle":
      return `LEFT JOIN LATERAL (
    SELECT max(l.timestamp_ms) FILTER (WHERE l.state = 'opened') AS opened_ms,
      max(l.timestamp_ms) FILTER (WHERE l.state = 'funded') AS funded_ms,
      max(l.timestamp_ms) FILTER (WHERE l.state = 'migrated') AS migrated_ms,
      max(l.timestamp_ms) FILTER (WHERE l.state = 'cancelled') AS cancelled_ms
    FROM chain_read_v1.presale_lifecycle l WHERE l.presale_id = p.presale_id
  ) lc ON TRUE`;
    case "interest":
      return `LEFT JOIN LATERAL (
    SELECT count(*)::int AS interested FROM social_follows f
    WHERE f.target_kind = 'presale' AND f.target_id = p.presale_id
  ) fol ON TRUE`;
    case "claims":
      // One price for every buyer: the first 50 claims (by wallet, an index walk) are exact up to rounding.
      return `LEFT JOIN LATERAL (
    SELECT sum(c.commitment - COALESCE(c.claimed_quote_refund, 0)) AS paid, sum(c.claimed_tokens) AS tokens
    FROM (
      SELECT pp.commitment, pp.claimed_quote_refund, pp.claimed_tokens
      FROM chain_read_v1.presale_positions pp
      WHERE p.lifecycle = 'migrated' AND pp.presale_id = p.presale_id AND pp.claim_digest IS NOT NULL AND pp.claimed_tokens > 0
      ORDER BY pp.wallet
      LIMIT 50
    ) c
  ) claims ON TRUE`;
    case "pin":
      return `LEFT JOIN social_presale_pins pin ON pin.presale_id = p.presale_id`;
    case "trust":
      // R3-23: one primary-key probe per sale; a sale with no row reads every flag false.
      return `LEFT JOIN social_sale_trust trust ON trust.presale_id = p.presale_id`;
  }
}

/** A full summary row of presale `p` (`parQuotes` the one-dollar quote types' placeholder). */
function summarySelect(parQuotes: string): string {
  return `SELECT p.presale_id, coalesce(p.sale_name,'') AS name, coalesce(p.sale_symbol,'') AS symbol, coalesce(p.sale_icon_url,'') AS icon_url, p.lifecycle,
    p.start_ms::text AS start_ms, p.end_ms::text AS end_ms, p.venue, p.participants::text AS participants,
    p.sale_token, p.sale_decimals::int AS sale_decimals, p.quote_symbol, p.quote_type,
    p.raise_target::text AS raise_target, p.total_commitments::text AS total_commitments, p.quote_decimals::int AS quote_decimals,
    ${quoteAtParSql(parQuotes)} AS stable,
    ${usdSql("p.raise_target", parQuotes)} AS target_usd,
    ${usdSql("p.total_commitments", parQuotes)} AS raised_usd,
    -- An allowlisted sale (no wallet cap: each wallet's is its allowlist leaf's) takes any positive amount (min 1 atom).
    (p.wallet_cap IS NULL) AS allowlisted,
    CASE WHEN p.wallet_cap IS NOT NULL THEN ${usdSql("p.min_commitment", parQuotes)} END AS min_commitment_usd,
    ${usdSql("p.wallet_cap", parQuotes)} AS wallet_cap_usd,
    CASE WHEN p.wallet_cap IS NOT NULL THEN p.min_commitment::text END AS min_commitment_atoms,
    p.wallet_cap::text AS wallet_cap_atoms,
    lc.opened_ms::text AS opened_ms, lc.funded_ms::text AS funded_ms, lc.migrated_ms::text AS migrated_ms,
    lc.cancelled_ms::text AS cancelled_ms,
    fol.interested,
    trim_scale(round(claims.paid / (10::numeric ^ p.quote_decimals) * ${quoteUsdSql(parQuotes)}
      / NULLIF(claims.tokens / (10::numeric ^ p.sale_decimals), 0), 12))::text AS claimed_price_usd,
    ${claimedPriceQuoteSql()} AS claimed_price_quote,
    trim_scale(sp.usd_price)::text AS price_usd,
    -- The two flags only: never who set them, when or why.
    COALESCE(trust.verified_team, FALSE) AS verified_team, COALESCE(trust.audited, FALSE) AS audited,
    ${SALE_METADATA_COLUMNS("m")},
    NULL::text AS sort_key
  FROM ${SHOWN_PRESALES} p
  ${(["prices", "lifecycle", "interest", "claims", "trust"] as const).map((join) => joinSql(join)).join("\n  ")}
  ${saleMetadataJoinSql("p.presale_id")}`;
}

/**
 * R3-40: what buyers paid per whole token in the sale's own coin, from the
 * claims (`paid` quote atoms over `tokens` sale atoms): exact numeric, at most
 * 18 places so a SUI price of a millionth keeps its significant digits.
 */
function claimedPriceQuoteSql(): string {
  return `trim_scale(round(claims.paid * (10::numeric ^ p.sale_decimals)
      / NULLIF(claims.tokens * (10::numeric ^ p.quote_decimals), 0), 18))::text`;
}

/** Which presales a tab holds at `now`: a sale scheduled to open later is upcoming until its start. */
function statusWhere(status: PresaleListStatus, now: () => string): string {
  if (status === "live") return liveSaleSql("p", now());
  if (status === "upcoming") return upcomingSaleSql("p", now());
  return closedSaleSql("p", now());
}

type SortSpec = Readonly<{
  key: (params: Params, asOfMs: number, parQuotes: () => string) => string;
  direction: "ASC" | "DESC";
  /** The joins the key reads. */
  joins?: readonly Join[];
}>;

/** The multiple (current price over the claims' price) or -1 when unknown, as SQL. */
const multipleKey = (parQuotes: string) => `COALESCE(round(sp.usd_price / NULLIF(claims.paid / (10::numeric ^ p.quote_decimals)
  * ${quoteUsdSql(parQuotes)} / NULLIF(claims.tokens / (10::numeric ^ p.sale_decimals), 0), 0), 6), -1)`;

const SORTS: Readonly<Record<PresaleListSort, SortSpec>> = {
  // Negative pin timestamps put recent selections first; positive deadlines order the rest.
  pinned: { key: () => "COALESCE(-extract(epoch FROM pin.pinned_at), p.end_ms)", direction: "ASC", joins: ["pin"] },
  ending: { key: () => "p.end_ms", direction: "ASC" },
  // Commits over the last six hours before the watermark, over the target.
  fastest: {
    key: (params, asOfMs) => `round((SELECT COALESCE(sum(v.quote_amount), 0) FROM chain_read_v1.activity v
      WHERE v.presale_id = p.presale_id AND v.kind = 'presale_commit'
        AND v.timestamp_ms > ${params.add(asOfMs - 6 * 3_600_000)}::bigint AND v.timestamp_ms <= ${params.add(asOfMs)}::bigint)
      / NULLIF(p.raise_target, 0), 8)`,
    direction: "DESC",
  },
  backed: { key: () => "p.participants", direction: "DESC" },
  opening: { key: () => "p.start_ms", direction: "ASC" },
  interest: { key: () => "fol.interested", direction: "DESC", joins: ["interest"] },
  recent: { key: () => "COALESCE(lc.cancelled_ms, lc.funded_ms, lc.migrated_ms, p.end_ms)", direction: "DESC", joins: ["lifecycle"] },
  best: { key: (_params, _asOfMs, parQuotes) => multipleKey(parQuotes()), direction: "DESC", joins: ["prices", "claims"] },
};

export type ListCursor = Readonly<{ key: string; presaleId: string }>;
const KEY = /^-?(0|[1-9][0-9]{0,39})(\.[0-9]{1,20})?$/;

export function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify([cursor.key, cursor.presaleId])).toString("base64url");
}

/** A cursor from `encodeListCursor`, or `invalid_parameter` (`cursor`). */
export function decodeListCursor(raw: string): ListCursor {
  let parsed: unknown;
  try {
    if (raw.length > 400) throw new Error("long");
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    parsed = null;
  }
  const decoded = z.tuple([z.string().regex(KEY), z.string().regex(SUI_OBJECT_ID_PATTERN)]).safeParse(parsed);
  if (!decoded.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
  return { key: decoded.data[0], presaleId: decoded.data[1] };
}

/** `numerator / denominator` atoms in basis points, floored (no float rounding). */
export function ratioBps(numerator: string, denominator: string): number {
  const bottom = BigInt(denominator);
  if (bottom <= 0n) return 0;
  return Number((BigInt(numerator) * 10_000n) / bottom);
}

/** `a / b` of two positive decimal strings to four places, or null. */
export function decimalRatio(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  const top = Number(a);
  const bottom = Number(b);
  if (!(top > 0) || !(bottom > 0)) return null;
  return String(Number((top / bottom).toFixed(4)));
}

export function summaryOf(
  row: SummaryRow,
  nowMs: number,
  presalePriceUsd: string | null = row.claimed_price_usd,
  presalePriceQuote: string | null = row.claimed_price_quote,
): SocialPresaleSummary {
  const endMs = Number(row.end_ms);
  const phase = presalePhase(row.lifecycle, Number(row.start_ms), endMs, nowMs);
  const funded = row.funded_ms === null ? null : Number(row.funded_ms);
  const cancelled = row.cancelled_ms === null ? null : Number(row.cancelled_ms);
  return {
    presale_id: row.presale_id,
    coin_type: row.sale_token,
    sale_decimals: row.sale_decimals,
    name: row.name,
    symbol: row.symbol,
    icon_url: row.icon_url,
    phase,
    venue: row.venue,
    start_ms: Number(row.start_ms),
    end_ms: endMs,
    ended_ms: cancelled ?? funded ?? (phase === "closed" ? endMs : null),
    launched_ms: row.migrated_ms === null ? null : Number(row.migrated_ms),
    target_usd: row.target_usd,
    raised_usd: row.raised_usd,
    quote_symbol: row.quote_symbol,
    quote_type: row.quote_type,
    quote_decimals: row.quote_decimals,
    target_atoms: row.raise_target,
    raised_atoms: row.total_commitments,
    fill_bps: ratioBps(row.total_commitments, row.raise_target),
    participants: Number(row.participants),
    allowlisted: row.allowlisted,
    interested: row.interested,
    presale_price_usd: presalePriceUsd,
    presale_price_quote: presalePriceQuote,
    price_usd: row.price_usd,
    multiple: phase === "trading" ? decimalRatio(row.price_usd, presalePriceUsd) : null,
    verified_team: row.verified_team === true,
    audited: row.audited === true,
    metadata: metadataOrNull(row),
  };
}

/** The sale's public details (R3-24), or null when it has none. */
function metadataOrNull(row: SaleMetadataRow) {
  const metadata = saleMetadataOf(row);
  return hasSaleMetadata(metadata) ? metadata : null;
}

export type ListQuery = Readonly<{
  status: PresaleListStatus;
  sort: PresaleListSort;
  cursor: ListCursor | null;
  limit: number;
  partnerId?: string;
  nowMs: number;
  /** The watermark's time: windows (fastest filling) end here. */
  asOfMs: number;
  /** R3-23: keep only the sales with each of these trust flags set. */
  trust?: readonly PresaleListTrustFilter[];
}>;

/**
 * The trust filters as one condition on presale `p`, or "" without any: a
 * semi-join to `social_sale_trust` by its primary key, so a sale with no row
 * never passes. `EXPLAIN (ANALYZE)` at launch scale decided against a partial
 * index on either flag (R3-23-AC-5, `loadtest/social-trust-scale.ts`).
 */
export function trustFilterSql(trust: readonly PresaleListTrustFilter[] | undefined): string {
  const flags = [...new Set(trust ?? [])].sort();
  if (flags.length === 0) return "";
  const set = flags.map((flag) => (flag === "verified_team" ? "t.verified_team" : "t.audited")).join(" AND ");
  return ` AND EXISTS (SELECT 1 FROM social_sale_trust t WHERE t.presale_id = p.presale_id AND ${set})`;
}

/**
 * Each tab applies the same optional partner and trust filters to the shown sales.
 */
function presaleFilters(params: Params, query: Pick<ListQuery, "trust" | "partnerId">): string {
  const partner = query.partnerId === undefined ? "" : ` AND p.partner_id = ${params.add(query.partnerId)}::text`;
  return trustFilterSql(query.trust) + partner;
}

/**
 * How many presales each tab holds at `nowMs` under the page's filters (the trust flags, a partner), whatever its
 * status, sort or cursor: the tab counts. One pass over the shown sales (each tab's own condition, `statusWhere`),
 * as small as the catalog: `EXPLAIN (ANALYZE)` at launch scale in `loadtest/social-coin-market-scale.ts`.
 */
export async function readStatusCounts(
  db: ReadableDatabase,
  query: Pick<ListQuery, "trust" | "partnerId" | "nowMs">,
): Promise<PresaleStatusCounts> {
  const params = new Params();
  const now = `${params.add(query.nowMs)}::bigint`;
  const filters = presaleFilters(params, query);
  const counts = PRESALE_LIST_STATUSES.map((status) => `count(*) FILTER (WHERE ${statusWhere(status, () => now)})::int AS ${status}`);
  const { rows } = await db.read<PresaleStatusCounts>(`SELECT ${counts.join(", ")} FROM ${PUBLIC_PRESALES} p WHERE TRUE${filters}`, params.values);
  const row = rows[0];
  return { live: row?.live ?? 0, upcoming: row?.upcoming ?? 0, ended: row?.ended ?? 0 };
}

/**
 * One keyset page of a tab: rows ordered by the sort's key, then presale id in
 * the same direction, strictly after `cursor`. A computed key (velocity,
 * interest, multiple) can move between pages; a row may then repeat or be
 * skipped once, never loop.
 */
export async function readSummaryPage(
  db: ReadableDatabase,
  query: ListQuery,
): Promise<{ rows: SummaryRow[]; nextCursor: string | null }> {
  if (!z.number().int().min(1).max(PRESALE_LIST_MAX_LIMIT).safeParse(query.limit).success) {
    throw new SocialRouteError("invalid_parameter", { extra: { parameter: "limit" } });
  }
  // Phase 1: the page's ids by the sort key, reading only the joins the key needs.
  const params = new Params();
  const spec = SORTS[query.sort];
  let parQuotesPlaceholder: string | null = null;
  const key = spec.key(params, query.asOfMs, () => (parQuotesPlaceholder ??= params.add(PRESALE_PAR_QUOTE_TYPES)));
  const filters = presaleFilters(params, query);
  const where = statusWhere(query.status, () => `${params.add(query.nowMs)}::bigint`) + filters;
  const comparison = spec.direction === "ASC" ? ">" : "<";
  let after = "";
  if (query.cursor) {
    after = `WHERE (r.sort_key::numeric, r.presale_id COLLATE "C") ${comparison} (${params.add(query.cursor.key)}::numeric, ${params.add(query.cursor.presaleId)}::text COLLATE "C")`;
  }
  const limit = params.add(query.limit + 1);
  const { rows: keys } = await db.read<{ presale_id: string; sort_key: string | null }>(
    `SELECT r.presale_id, r.sort_key FROM (
       SELECT p.presale_id, (${key})::text AS sort_key
       FROM ${PUBLIC_PRESALES} p
       ${(spec.joins ?? []).map((join) => joinSql(join)).join("\n       ")}
       WHERE ${where}
     ) r
     ${after}
     ORDER BY r.sort_key::numeric ${spec.direction}, r.presale_id COLLATE "C" ${spec.direction}
     LIMIT ${limit}`,
    params.values,
  );
  const page = keys.slice(0, query.limit);
  // Phase 2: the full rows of those ids only.
  const full = new Map((await readSummaries(db, page.map((row) => row.presale_id))).map((row) => [row.presale_id, row]));
  const rows = page.flatMap((row) => {
    const summary = full.get(row.presale_id);
    return summary ? [{ ...summary, sort_key: row.sort_key }] : [];
  });
  const last = page[page.length - 1];
  const nextCursor = keys.length > query.limit && last && last.sort_key !== null
    ? encodeListCursor({ key: last.sort_key, presaleId: last.presale_id })
    : null;
  return { rows, nextCursor };
}

/** The summary rows of `presaleIds` (any status), in no particular order. */
export async function readSummaries(db: ReadableDatabase, presaleIds: readonly string[]): Promise<SummaryRow[]> {
  if (presaleIds.length === 0) return [];
  const params = new Params();
  const select = summarySelect(params.add(PRESALE_PAR_QUOTE_TYPES));
  const ids = params.add([...new Set(presaleIds)]);
  const { rows } = await db.read<SummaryRow>(`${select} WHERE p.presale_id = ANY(${ids}::text[])`, params.values);
  return rows;
}

/** The condition on presale `p` of a tab; `now` adds the time parameter when the tab needs it (also Home's open and pending presales). */
export function statusFilterSql(status: PresaleListStatus, now: () => string): string {
  return statusWhere(status, now);
}
