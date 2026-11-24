import { DISPLAY_PRICES } from "@blast/core/modules/social/prices/test-sui.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { fillPercent } from "@blast/core/lib/format.ts";
import type { ProfilePresale } from "@blast/core/modules/social/contracts/profile-page.ts";
import { VESTING_MAX_MS } from "@blast/core/modules/social/contracts/vesting.ts";
import { SHOWN_PRESALES, presalePhase } from "@blast/core/modules/social/read-model/chain-presales.ts";

/**
 * Presale rows as profile cards show them, read from blast-infra's
 * `chain_read_v1.presales` (public chain data), with what the calls need to
 * value a commit: the sale coin's latest price and, for a trading sale, its
 * claims (net raise and tokens delivered).
 */

export type PresaleFacts = Readonly<{
  presale: ProfilePresale;
  quoteSymbol: string;
  quoteDecimals: number;
  saleDecimals: number;
  /** The latest `chain_read_v1.prices` row of the sale coin, if any (`text`: the exact `numeric`, for R3-32's arithmetic). */
  price: Readonly<{ usd: number; text: string; asOfMs: number }> | null;
  /** Over claimed positions of a trading sale: quote atoms kept (commitment − refund), commitment and tokens. */
  claims: Readonly<{ net: number; committed: number; tokens: number }> | null;
  /** R3-40: the quote coin's latest `chain_read_v1.prices` row (USD a whole coin), if any. */
  quotePrice: Readonly<{ text: string; asOfMs: number }> | null;
}>;

type PresaleRow = {
  presale_id: string;
  sale_token?: string;
  sale_symbol: string;
  sale_name: string;
  sale_icon_url: string;
  verified_team?: boolean;
  quote_symbol: string;
  quote_decimals: number;
  sale_decimals: number;
  lifecycle: string;
  venue: string;
  start_ms: string;
  end_ms: string;
  raise_target: string;
  total_commitments: string;
  price: string | null;
  price_as_of_ms: string | null;
  claims_net: string | null;
  claims_committed: string | null;
  claims_tokens: string | null;
  quote_price: string | null;
  quote_price_as_of_ms: string | null;
  launched_ms: string | null;
  first_unlock_ms: string | null;
};

/**
 * One row per presale id. A trading (`migrated`) sale also sums a sample of
 * its claimed positions: claims are pro rata, so every claim has the same
 * net quote per token (the presale price) and the same filled share; up to
 * 50 claims (the `presale_positions` primary key starts with the presale id)
 * give that price without scanning every backer. Other sales skip it.
 * R3-85: each row also carries the coin's launch (its `migrated` lifecycle
 * row, as the presale summary reads it) and the sale's first unlock (the
 * earliest cliff end over every vesting schedule of the sale; null without
 * one), each a lookup by presale id, for the compact stepper's progress.
 */
const PRESALES_SQL = `
  SELECT p.presale_id, p.sale_token, p.sale_symbol, p.sale_name, coalesce(p.sale_icon_url,'') AS sale_icon_url, p.quote_symbol,
    p.quote_decimals::int AS quote_decimals, p.sale_decimals::int AS sale_decimals, p.lifecycle, p.venue,
    p.start_ms::text AS start_ms, p.end_ms::text AS end_ms, p.raise_target::text AS raise_target,
    p.total_commitments::text AS total_commitments,
    pr.usd_price::text AS price, pr.as_of_ms::text AS price_as_of_ms,
    claims.net::text AS claims_net, claims.committed::text AS claims_committed, claims.tokens::text AS claims_tokens,
    qp.usd_price::text AS quote_price, qp.as_of_ms::text AS quote_price_as_of_ms,
    (SELECT max(l.timestamp_ms) FROM chain_read_v1.presale_lifecycle l
      WHERE l.presale_id = p.presale_id AND l.state = 'migrated')::text AS launched_ms,
    (SELECT min(LEAST(v.start_ms + v.cliff_ms, ${VESTING_MAX_MS}::numeric)) FROM chain_read_v1.vesting_schedules v
      WHERE v.presale_id = p.presale_id)::text AS first_unlock_ms,
    coalesce(trust.verified_team, false) AS verified_team
  FROM ${SHOWN_PRESALES} p
  LEFT JOIN social_sale_trust trust ON trust.presale_id = p.presale_id
  LEFT JOIN ${DISPLAY_PRICES} pr ON pr.coin_type = p.sale_token
  LEFT JOIN ${DISPLAY_PRICES} qp ON qp.coin_type = p.quote_type
  LEFT JOIN LATERAL (
    SELECT sum(c.commitment - COALESCE(c.claimed_quote_refund, 0)) AS net, sum(c.commitment) AS committed,
      sum(c.claimed_tokens) AS tokens
    FROM (
      SELECT pp.commitment, pp.claimed_quote_refund, pp.claimed_tokens
      FROM chain_read_v1.presale_positions pp
      WHERE p.lifecycle = 'migrated' AND pp.presale_id = p.presale_id AND pp.claim_digest IS NOT NULL AND pp.claimed_tokens > 0
      ORDER BY pp.presale_id, pp.wallet
      LIMIT 50
    ) c
  ) claims ON true
  WHERE p.presale_id = ANY($1::text[])`;

const units = (atoms: string | null, decimals: number): number => (atoms === null ? 0 : Number(atoms) / 10 ** decimals);

export function presaleFactsOf(row: PresaleRow, nowMs: number): PresaleFacts {
  const endMs = Number(row.end_ms);
  const tokens = row.claims_tokens === null ? 0 : Number(row.claims_tokens);
  return {
    presale: {
      presale_id: row.presale_id,
      coin_type: row.sale_token,
      ...coinLabel({ coinType: row.sale_token ?? "", symbol: row.sale_symbol, name: row.sale_name }),
      icon_url: row.sale_icon_url,
      status: presalePhase(row.lifecycle, Number(row.start_ms), endMs, nowMs),
      venue: row.venue,
      start_ms: Number(row.start_ms),
      end_ms: endMs,
      fill_pct: fillPercent(units(row.total_commitments, row.quote_decimals), units(row.raise_target, row.quote_decimals)),
      quote_symbol: row.quote_symbol,
      quote_decimals: row.quote_decimals,
      launched_ms: row.launched_ms === null ? null : Number(row.launched_ms),
      first_unlock_ms: row.first_unlock_ms === null ? null : Number(row.first_unlock_ms),
      ...(row.verified_team === true ? { verified_team: true } : {}),
    },
    quoteSymbol: row.quote_symbol,
    quoteDecimals: row.quote_decimals,
    saleDecimals: row.sale_decimals,
    price: row.price === null || row.price_as_of_ms === null
      ? null
      : { usd: Number(row.price), text: row.price, asOfMs: Number(row.price_as_of_ms) },
    claims: tokens > 0 ? { net: Number(row.claims_net), committed: Number(row.claims_committed), tokens } : null,
    quotePrice: row.quote_price === null || row.quote_price_as_of_ms === null ? null : { text: row.quote_price, asOfMs: Number(row.quote_price_as_of_ms) },
  };
}

/** The facts of each presale id `chain_read_v1.presales` knows, by id. */
export async function readPresaleFacts(
  db: ReadableDatabase,
  presaleIds: readonly string[],
  nowMs: number,
): Promise<Map<string, PresaleFacts>> {
  if (presaleIds.length === 0) return new Map();
  const { rows } = await db.read<PresaleRow>(PRESALES_SQL, [[...new Set(presaleIds)]]);
  return new Map(rows.map((row) => [row.presale_id, presaleFactsOf(row, nowMs)]));
}
