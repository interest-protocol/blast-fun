import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/modules/social/contracts/portfolio.ts";
import { PROFILE_CALLS_MAX, type ProfileCall, type ProfileTrackRecord } from "@blast/core/modules/social/contracts/profile-page.ts";
import { costBasisBook, presaleCallMultiple, readCostBasisLedgerOrNull, type PresaleAcquisition } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { SHOWN_ACTIVITY, SHOWN_FEED_ENTRIES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { namedOwnerSql } from "@blast/core/modules/social/read-model/naming.ts";
import { activityOfAnyEntrySql } from "@blast/core/modules/social/presales/sql.ts";
import { readPresaleFacts, type PresaleFacts } from "@blast/server/modules/social/profiles/presales.ts";

/**
 * An account's presale calls (owner decision OA-9: every named commit is a
 * call) and its track record (OA-14: presales backed, launched, PnL). Only
 * commits the naming rule attributes to the account now count, exactly as
 * its profile items: a private account, an account not sharing yet and a
 * commit from before sharing began give nothing. Everything read is public
 * chain data or public social state, so the answer is the same for every
 * reader.
 */

type CommitRow = { presale_id: string; quote_atoms: string; usd: string | null; unpriced: string; last_ms: string };

/**
 * The account's named commits per presale. The actor filter takes the
 * account's addresses (an index lookup per source, `readAccountAddresses`)
 * so the activity `(actor, timestamp_ms)` index serves it; the naming rule
 * then keeps the commits named for this account, and only sales the web
 * shows (inside the shared reader, before the `LIMIT`: a hidden sale's commits
 * would otherwise take one of the `PROFILE_CALLS_MAX` places, then be dropped
 * by `readPresaleFacts`, leaving the list one call short).
 */
const COMMITS_SQL = `
  SELECT e.presale_id, sum(e.quote_amount)::text AS quote_atoms, sum(e.usd_value)::text AS usd,
    (count(*) - count(e.usd_value))::text AS unpriced, max(e.occurred_at_ms)::text AS last_ms
  FROM ${SHOWN_FEED_ENTRIES} e
  CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named
  WHERE e.source = 'activity' AND e.kind = 'presale_commit' AND e.presale_id IS NOT NULL
    AND e.actor = ANY($2::text[]) AND named.account_id = $1::uuid
  GROUP BY e.presale_id
  ORDER BY max(e.occurred_at_ms) DESC
  LIMIT ${PROFILE_CALLS_MAX}`;

/**
 * The account's latest active why per called presale (`social_whys_author_idx`), on one of its commits to it that
 * the naming rule attributes to the account now: the same commits `COMMITS_SQL` counts, so a why on a commit no
 * longer named to the account (its wallet unlinked, sharing restarted) is not the call's thesis. Each candidate's
 * activity row is one probe of the view's key.
 */
export const CALL_WHYS_SQL = `
  SELECT DISTINCT ON (w.presale_id) w.presale_id, w.text
  FROM social_whys w
  CROSS JOIN LATERAL (
    SELECT a.actor, a.timestamp_ms AS occurred_at_ms FROM ${SHOWN_ACTIVITY} a
    WHERE ${activityOfAnyEntrySql("w.entry_id")} AND a.kind = 'presale_commit'
  ) e
  WHERE w.author_account_id = $1::uuid AND w.state = 'active' AND w.presale_id = ANY($2::text[])
    AND ${namedOwnerSql("e")} = $1::uuid
  ORDER BY w.presale_id, w.created_at DESC, w.entry_id`;

const usd2 = (value: number): string => (Math.round(value * 100) / 100).toFixed(2);

/** A positive decimal string with up to `digits` places, trailing zeros kept (the schema's form). */
const fixed = (value: number, digits: number): string => value.toFixed(digits);

/** A price as a plain decimal string (six significant digits, never exponent notation). */
export function priceString(value: number): string {
  const text = Number(value.toPrecision(6)).toFixed(12);
  return text.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A presale's price per token (net raise ÷ tokens delivered, from its claims;
 * USDC quotes only), its sale coin's fresh price (at most 120 s old) and,
 * once trading, the multiple between them.
 */
export function presalePrices(facts: PresaleFacts, nowMs: number): Readonly<{ entry: number | null; current: number | null; multiple: number | null }> {
  const { claims, price } = facts;
  const entry =
    facts.quoteSymbol === "USDC" && claims && claims.tokens > 0
      ? (claims.net / 10 ** facts.quoteDecimals) / (claims.tokens / 10 ** facts.saleDecimals)
      : null;
  const current = price && nowMs - price.asOfMs <= PORTFOLIO_PRICE_MAX_AGE_MS ? price.usd : null;
  const multiple = facts.presale.status === "trading" && entry !== null && entry > 0 && current !== null ? current / entry : null;
  return { entry, current, multiple };
}

/**
 * A trading call's multiple. Once the account claimed in the presale, R3-32's
 * basis restricted to that acquisition (`presaleCallMultiple`): the same
 * exact figure `/me/portfolio` and `/me/presales` answer as `pnl_multiple`
 * for a position whose only acquisition is its claim (OA-9 and R3-32-AC-5
 * agree to the last place). Before a claim, or when the account's ledger
 * could not be read (`acquisition` undefined), the presale's own
 * `price ÷ entry`.
 */
function callMultiple(facts: PresaleFacts, nowMs: number, saleMultiple: number | null, acquisition: PresaleAcquisition | undefined): string | null {
  if (facts.presale.status !== "trading") return null;
  if (acquisition) {
    const price = facts.price && { usd_price: facts.price.text, as_of_ms: facts.price.asOfMs };
    return presaleCallMultiple(acquisition, facts.saleDecimals, price, nowMs);
  }
  return saleMultiple === null ? null : fixed(saleMultiple, 4);
}

function callValue(committed: number | null, presale: PresaleFacts["presale"], claims: PresaleFacts["claims"], multiple: number | null): number | null {
  let value: number | null = null;
  if (committed !== null) {
    if (presale.status === "cancelled") value = committed;
    else if (multiple !== null && claims) {
      // Pro rata: the claimed share of each commitment bought tokens, the rest came back.
      const filled = claims.committed > 0 ? Math.min(1, claims.net / claims.committed) : 1;
      value = committed * (1 - filled) + committed * filled * multiple;
    }
  }
  return value;
}

/**
 * One call from the account's commits to a presale and that presale's facts
 * at `nowMs`; `acquisition` is what the presale delivered to the account's
 * wallets (R3-32's ledger), when it claimed; `why` is its thesis on the call.
 */
export function callOf(
  commit: CommitRow,
  facts: PresaleFacts,
  nowMs: number,
  acquisition?: PresaleAcquisition,
  why: string | null = null,
): ProfileCall {
  const usdc = facts.quoteSymbol === "USDC";
  // USDC commits are valued at their quote amount; other quotes at the indexer's USD values when all are known.
  const committed = usdc
    ? Number(commit.quote_atoms) / 10 ** facts.quoteDecimals
    : commit.usd !== null && Number(commit.unpriced) === 0
      ? Number(commit.usd)
      : null;
  const { presale, claims } = facts;
  const { entry, current, multiple: saleMultiple } = presalePrices(facts, nowMs);
  const multipleText = callMultiple(facts, nowMs, saleMultiple, acquisition);
  const multiple = multipleText === null ? null : Number(multipleText);
  const value = callValue(committed, presale, claims, multiple);
  return {
    presale,
    committed_usd: committed === null ? null : usd2(committed),
    committed_atoms: commit.quote_atoms,
    entry_price_usd: entry === null ? null : priceString(entry),
    price_usd: presale.status === "trading" && current !== null ? priceString(current) : null,
    multiple: multipleText,
    value_usd: value === null ? null : usd2(value),
    pnl_usd: value === null || committed === null ? null : usd2(value - committed),
    last_commit_ms: Number(commit.last_ms),
    why,
    series: null,
  };
}

/** Trading calls best multiple first, then every other call newest commit first. */
export function sortCalls(calls: readonly ProfileCall[]): ProfileCall[] {
  const rank = (call: ProfileCall) => (call.multiple === null ? -1 : Number(call.multiple));
  return [...calls].sort((a, b) => {
    const trading = Number(b.multiple !== null) - Number(a.multiple !== null);
    if (trading !== 0) return trading;
    if (a.multiple !== null) return rank(b) - rank(a) || b.last_commit_ms - a.last_commit_ms;
    return b.last_commit_ms - a.last_commit_ms || (a.presale.presale_id < b.presale.presale_id ? 1 : -1);
  });
}

/**
 * OA-14's three tiles. PnL sums the settled calls (trading with a value, and
 * cancelled ones at zero); it is null while none is settled or while a
 * trading call has no value (its price is missing or stale), so the tile
 * never shows a partial sum.
 */
export function trackRecordOf(calls: readonly ProfileCall[]): ProfileTrackRecord {
  const trading = calls.filter((call) => call.presale.status === "trading");
  const settled = calls.filter((call) => call.presale.status === "trading" || call.presale.status === "cancelled");
  const complete = settled.length > 0 && settled.every((call) => call.pnl_usd !== null);
  return {
    presales_backed: calls.length,
    launched: trading.length,
    pnl_usd: complete ? usd2(settled.reduce((sum, call) => sum + Number(call.pnl_usd), 0)) : null,
  };
}

/**
 * The calls and track record of the account `accountId` at `nowMs`, each
 * call with the account's thesis on it. The account's activity ledger (R3-32) is read only when it has a call, and
 * gives each claimed presale's acquisition; a ledger cut short or unreadable
 * gives none, so every call keeps the presale's own multiple.
 */
export async function readCalls(
  db: ReadableDatabase,
  accountId: string,
  nowMs: number,
): Promise<Readonly<{ calls: ProfileCall[]; track_record: ProfileTrackRecord }>> {
  const addresses = await readAccountAddresses(db, accountId);
  if (addresses.length === 0) return { calls: [], track_record: trackRecordOf([]) };
  const { rows } = await db.read<CommitRow>(COMMITS_SQL, [accountId, addresses]);
  if (rows.length === 0) return { calls: [], track_record: trackRecordOf([]) };
  const presaleIds = rows.map((row) => row.presale_id);
  const [facts, ledger, whys] = await Promise.all([
    readPresaleFacts(db, presaleIds, nowMs),
    readCostBasisLedgerOrNull(db, addresses),
    db.read<{ presale_id: string; text: string }>(CALL_WHYS_SQL, [accountId, presaleIds]),
  ]);
  const whyOf = new Map(whys.rows.map((row) => [row.presale_id, row.text]));
  const book = ledger === null || ledger.truncated ? null : costBasisBook(ledger);
  const calls = sortCalls(
    rows.flatMap((row) => {
      const presale = facts.get(row.presale_id);
      return presale ? [callOf(row, presale, nowMs, book?.presales.get(row.presale_id), whyOf.get(row.presale_id) ?? null)] : [];
    }),
  );
  return { calls, track_record: trackRecordOf(calls) };
}
