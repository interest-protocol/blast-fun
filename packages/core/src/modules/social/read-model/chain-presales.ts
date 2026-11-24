import { saleLifecycleAt, type PresalePhase } from "../contracts/presales.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "../contracts/create.ts";

/** Complete sale identities only. Derived readers inline without owning chain schema. */
export const SHOWN_PRESALES = `(SELECT * FROM chain_read_v1.presales
    WHERE sale_decimals IS NOT NULL AND quote_decimals IS NOT NULL AND quote_symbol IS NOT NULL AND venue IS NOT NULL)`;

/** Use for public discovery, where test markets cannot occupy a page or shortlist. */
export const PUBLIC_PRESALES = `(SELECT * FROM ${SHOWN_PRESALES} p
    WHERE p.quote_type IS DISTINCT FROM '${CREATE_TEST_SUI_QUOTE_TYPE}')`;

/** Filtering happens inside the source, before callers order or limit their page. */
export const SHOWN_ACTIVITY = `(SELECT activity.* FROM chain_read_v1.activity activity
  WHERE ${shownSaleActivitySql("activity")})`;

export const SHOWN_FEED_ENTRIES = `(SELECT entry.* FROM social_feed_entries entry
  WHERE ${shownSaleActivitySql("entry")})`;

export const PUBLIC_ACTIVITY = `(SELECT activity.* FROM chain_read_v1.activity activity
  WHERE ${shownSaleActivitySql("activity", PUBLIC_PRESALES)})`;

export const PUBLIC_FEED_ENTRIES = `(SELECT entry.* FROM social_feed_entries entry
  WHERE ${shownSaleActivitySql("entry", PUBLIC_PRESALES)})`;

function shownSaleActivitySql(alias: string, presales = SHOWN_PRESALES): string {
  return `CASE WHEN ${alias}.presale_id IS NOT NULL
      THEN EXISTS (SELECT 1 FROM ${presales} s WHERE s.presale_id = ${alias}.presale_id)
      ELSE ${alias}.coin_type IN (SELECT s.sale_token FROM ${presales} s) END`;
}

/** The sale takes commitments at `nowMs`: open, its start reached and its end not. `liveSaleSql` is its SQL twin. */
export function saleIsLive(sale: Readonly<{ lifecycle: string; start_ms: number; end_ms: number }>, nowMs: number): boolean {
  return saleLifecycleAt(sale.lifecycle, sale.start_ms, nowMs) === "open" && nowMs < sale.end_ms;
}

/** A presale's phase at `nowMs` from its chain lifecycle (`saleLifecycleAt`); an open sale past its end is closed. */
export function presalePhase(lifecycle: string, startMs: number, endMs: number, nowMs: number): PresalePhase {
  switch (saleLifecycleAt(lifecycle, startMs, nowMs)) {
    case "pending":
      return "pending";
    case "open":
      return nowMs < endMs ? "open" : "closed";
    case "funded":
      return "funded";
    case "migrated":
      return "trading";
    case "cancelled":
      return "cancelled";
    default:
      return "closed";
  }
}

/** Presale `p` takes commitments at `now` (an SQL time expression); the SQL twin of `saleIsLive`. */
export function liveSaleSql(alias: string, now: string): string {
  return `(${alias}.lifecycle = 'open' AND ${alias}.start_ms <= ${now} AND ${alias}.end_ms > ${now})`;
}

/** Presale `p` has not opened at `now`: pending, or open with its scheduled start still ahead (`saleLifecycleAt`). */
export function upcomingSaleSql(alias: string, now: string): string {
  return `(${alias}.lifecycle = 'pending' OR (${alias}.lifecycle = 'open' AND ${alias}.start_ms > ${now}))`;
}

/** Presale `p` has stopped taking commitments at `now`: settled, or open past its end. */
export function closedSaleSql(alias: string, now: string): string {
  return `(${alias}.lifecycle IN ('funded', 'migrated', 'cancelled') OR (${alias}.lifecycle = 'open' AND ${alias}.end_ms <= ${now}))`;
}

/** Saved Home pins are visible only while the sale is upcoming or still accepting commits. */
export function pinnablePresaleSql(alias: string, now: string): string {
  return `(${alias}.lifecycle = 'pending' OR (${alias}.lifecycle = 'open' AND ${alias}.end_ms > ${now}))`;
}
