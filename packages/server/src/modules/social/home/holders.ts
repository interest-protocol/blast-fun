import { z } from "zod";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import {
  HOME_HOLDERS_DEFAULT,
  HOME_HOLDERS_MAX,
  type HomeHolderPosition,
  type HomeHoldersPage,
} from "@blast/core/modules/social/contracts/coin-market.ts";
import { atomsToUsd, isFreshPrice, type PortfolioPrice } from "@blast/core/modules/social/portfolio/read.ts";
import { displayPriceOf } from "@blast/core/modules/social/prices/test-sui.ts";
import { activityOfAnyEntrySql, addressesOfAccountsSql } from "@blast/core/modules/social/presales/sql.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { namedOwnerSql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { readTrackedPoolMarket } from "@blast/server/modules/launchpad-market/legacy-fdv.ts";
import { optionalSource } from "@blast/server/modules/social/optional-source.ts";
import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";

import { actorOf, shareBps } from "@blast/server/modules/social/home/aggregate.ts";
import { readPeople, readTopHolders, type HolderRow } from "@blast/server/modules/social/home/coins.ts";
import { HOME_LIST_COIN_SOURCES } from "@blast/server/modules/social/home/sources.ts";
import { readHomeBounds } from "@blast/server/modules/social/home/sql.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import {
  COST_BASIS_KINDS,
  COST_BASIS_ROWS_PER_WALLET,
  UNKNOWN_BASIS,
  coinBasisFigures,
  costBasisBook,
  type CostBasisRow,
} from "@blast/server/modules/social/portfolio/cost-basis.ts";
import { quotePerToken } from "@blast/server/modules/social/presales/quote-price.ts";

/**
 * Redesign gap 3: the coin's largest holders with each one's cost basis
 * (`HomeHoldersPage`, `contracts/coin-market.ts`).
 *
 * - **Holders** are Home's (`readTopHolders`): `chain_read_v1.coin_balances`
 *   now, an account's named wallets summed, the sale's object and pools left
 *   out.
 * - **Basis** is the portfolio's rule (`portfolio/cost-basis.ts`, R3-32: the
 *   figures a wallet's Positions table shows), applied to each holder on its
 *   own: an account over every wallet the naming rule gives it (a transfer
 *   between its wallets changes nothing), an unnamed wallet over itself.
 * - **Privacy.** A named account's figures are shown only when it shares its
 *   portfolio (`portfolio_public`, not private), as Home's traders are; the
 *   others answer the unknown basis, so its P&L is never derived from its
 *   name. An unnamed wallet is chain data only, and always answered.
 * - **Bounded.** One ledger statement for the page's wallets: per wallet a
 *   range of blast-infra's `(actor, timestamp_ms DESC)` index read oldest
 *   first, kept to this sale, at most `COST_BASIS_ROWS_PER_WALLET + 1` rows;
 *   a wallet over the cap makes its holder's basis unknown, never wrong.
 * - **Thesis.** A named holder's `why`: its latest active why on one of its
 *   own posts about the coin (a commit, claim or trade the naming rule
 *   attributes to it now), as its theses and the coin's discussion count
 *   them. Public social state, so it is shown whether or not the account
 *   shares its portfolio; a wallet no account names has none.
 */

const limitSchema = z.string().regex(/^[1-9][0-9]{0,2}$/).transform(Number).pipe(z.number().max(HOME_HOLDERS_MAX));

/** `limit`, at most once, 1 to `HOME_HOLDERS_MAX` (default `HOME_HOLDERS_DEFAULT`). */
export function parseHoldersLimit(params: URLSearchParams): number {
  const values = params.getAll("limit");
  if (values.length === 0) return HOME_HOLDERS_DEFAULT;
  return socialParameter(limitSchema, values.length === 1 ? values[0] : null, "limit");
}

/**
 * $1 coin type: the coin's identity and price. Every coin Home lists by id has holders here: a shown sale, a
 * launch vault coin, a curve still filling or a tracked pool (`HOME_LIST_COIN_SOURCES`). A coin of a hidden sale
 * stays unknown. The lookup is by the source's id (its shown sale's id, else the coin type), as Home's saved coins
 * read it: Postgres pushes that filter into every branch, a filter on `sale_token` it applies only after reading
 * every vault and curve. `sale_token = $1` stays beside it so the price, curve and supply joins read one coin.
 * A coin without a sale takes its live supply, else its total, else (a tracked pool coin) the node's circulating
 * supply, as Home's top 10 does.
 */
const COIN_SQL = `SELECT c.presale_id, c.sale_token AS coin_type, c.sale_decimals::int AS sale_decimals, c.pool_id,
    trim_scale(pr.usd_price)::text AS price_usd, pr.as_of_ms::text AS price_as_of_ms,
    coalesce(cs.supply, cs.total_supply)::text AS supply, lp.pool_id AS launch_id, c.tracked_pool_only
  FROM ${HOME_LIST_COIN_SOURCES} c
  LEFT JOIN ${displayPriceOf("c.sale_token")} pr ON TRUE
  LEFT JOIN chain_read_v1.pools lp ON c.presale_id IS NULL AND lp.coin_type = c.sale_token AND lp.venue = 'blast_curve'
  LEFT JOIN chain_read_v1.coins cs ON c.presale_id IS NULL AND cs.coin_type = c.sale_token
  WHERE c.source_id = coalesce((SELECT p.presale_id FROM ${SHOWN_PRESALES} p WHERE p.sale_token = $1 LIMIT 1), $1)
    AND c.sale_token = $1
  LIMIT 1`;
assertChainReadThroughViews(COIN_SQL);

type CoinRow = Readonly<{ presale_id: string | null; coin_type: string; sale_decimals: number; pool_id: string | null; price_usd: string | null; price_as_of_ms: string | null; supply: string | null; launch_id: string | null; tracked_pool_only: boolean }>;

/** $1 account ids: those that share their portfolio. */
const SHARING_SQL = `SELECT a.account_id::text AS account_id FROM social_accounts a
  WHERE a.account_id = ANY($1::uuid[]) AND a.portfolio_public AND a.privacy <> 'private'`;

/** $1 account ids: every wallet the naming rule's owners view gives each (`social_wallet_owners`, by key). */
const ACCOUNT_WALLETS_SQL = `SELECT w.account_id::text AS account_id, w.address FROM (${addressesOfAccountsSql("$1::uuid[]")}) w`;

/**
 * $1 account ids, $2 the sale (null for a standalone vault coin), $3 the coin, $4 the kinds the request hides:
 * each account's latest active why (`social_whys_author_idx`) on its own post about the coin. The coin's posts
 * are the discussion's: whys stamped with the sale (0066, and trades since 0098), or unstamped on a trade of the
 * coin. Each candidate's activity row is one probe of the view's key, kept when the naming rule names its author
 * for it now.
 */
export const HOLDER_WHYS_SQL = `
  SELECT DISTINCT ON (w.author_account_id) w.author_account_id::text AS account_id, w.text
  FROM social_whys w
  CROSS JOIN LATERAL (
    SELECT a.kind, a.actor, a.timestamp_ms AS occurred_at_ms, a.coin_type FROM chain_read_v1.activity a
    WHERE ${activityOfAnyEntrySql("w.entry_id")}
  ) e
  WHERE w.author_account_id = ANY($1::uuid[]) AND w.state = 'active'
    AND (w.presale_id = $2::text OR (w.presale_id IS NULL AND e.coin_type = $3::text))
    AND e.kind IN ('presale_commit', 'presale_claim', 'trade_buy', 'trade_sell') AND NOT (e.kind = ANY($4::text[]))
    AND ${namedOwnerSql("e")} = w.author_account_id
  ORDER BY w.author_account_id, w.created_at DESC, w.entry_id`;
assertChainReadThroughViews(HOLDER_WHYS_SQL);

/**
 * $1 wallets, $2 the sale, $3 the basis kinds, $4 rows per wallet, $5 and $6
 * the presale and market pipelines' committed checkpoints: each wallet's rows
 * of this sale in chain order (the portfolio's ledger, kept to one sale
 * inside the scan), bounded by the watermark as every Home read is, so the
 * basis never counts a trade the balances do not reflect yet. The sale is
 * one `COIN_SQL` found in the shown coin sources, so no row of a hidden sale
 * is read and the scan carries no per-row shown-sale check.
 */
export const HOLDER_LEDGER_SQL = `
  SELECT r.kind, r.presale_id, r.actor, r.quote_amount, r.coin_amount, r.quote_refund, r.usd_value
  FROM unnest((SELECT $1::text[])) AS w(address)
  CROSS JOIN LATERAL (
    SELECT a.kind, a.presale_id, a.actor, a.quote_amount::text AS quote_amount, a.coin_amount::text AS coin_amount,
      a.quote_refund::text AS quote_refund, a.usd_value::text AS usd_value,
      a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part
    FROM chain_read_v1.activity a
    WHERE a.actor = w.address AND a.presale_id = $2::text AND a.kind = ANY($3::text[])
      AND a.checkpoint <= CASE WHEN a.kind IN ('presale_commit', 'presale_claim') THEN $5::bigint ELSE $6::bigint END
    ORDER BY a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part
    LIMIT $4
  ) r
  ORDER BY r.timestamp_ms, r.checkpoint, r.tx_slot, r.event_slot, r.part`;
assertChainReadThroughViews(HOLDER_LEDGER_SQL);

/** Basis per whole token: cents over tokens, twelve significant digits; null for an empty side. */
export function averageEntryUsd(basisUsd: string, heldAtoms: string, decimals: number): string | null {
  const cents = /^(0|[1-9][0-9]*)\.([0-9]{2})$/.exec(basisUsd);
  if (!cents) return null;
  return quotePerToken(BigInt(cents[1]! + cents[2]!), 2, heldAtoms, decimals);
}

/** `hiddenKinds`: the activity kinds the request does not show (trades while trading is hidden); no why on one is a thesis. */
export type HoldersReadContext = Readonly<{
  nowMs: number;
  terms: PresaleTermsReader | null;
  hiddenKinds: readonly string[];
  /** The node's tracked pool supplies (shared, cached), for a tracked coin's shares when the index has no supply. */
  trackedPoolMarket?: typeof readTrackedPoolMarket;
}>;

/**
 * Each answered holder's wallets: a sharing account's named wallets (the
 * holding one at least), an unnamed wallet itself. A wallet listed as a
 * holder of its own (not named now) keeps its own rows. Accounts that keep
 * their portfolio private are absent: their basis is never read.
 */
function walletsOfHolders(
  rows: readonly HolderRow[],
  shared: ReadonlySet<string>,
  accountWallets: readonly Readonly<{ account_id: string; address: string }>[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const walletsOf = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.account_id === null || shared.has(row.account_id)) walletsOf.set(row.who, new Set([row.wallet]));
  }
  for (const row of accountWallets) {
    if (!walletsOf.has(`w:${row.address}`)) walletsOf.get(`a:${row.account_id}`)?.add(row.address);
  }
  return walletsOf;
}

type HolderLedgers = Readonly<{ rows: ReadonlyMap<string, readonly CostBasisRow[]>; truncated: ReadonlySet<string> }>;

/** Every answered holder's ledger rows of the sale, and the holders a wallet of which went past the cap; null when the read failed. */
async function readHolderLedgers(
  db: ReadableDatabase,
  presaleId: string,
  walletsOf: ReadonlyMap<string, ReadonlySet<string>>,
  bounds: Readonly<{ presaleCheckpoint: number; marketCheckpoint: number }>,
): Promise<HolderLedgers | null> {
  const holderOfWallet = new Map<string, string>();
  for (const [who, wallets] of walletsOf) for (const wallet of wallets) holderOfWallet.set(wallet, who);
  if (holderOfWallet.size === 0) return { rows: new Map(), truncated: new Set() };
  let ledger: readonly CostBasisRow[];
  try {
    ({ rows: ledger } = await db.read<CostBasisRow>(HOLDER_LEDGER_SQL, [
      [...holderOfWallet.keys()], presaleId, [...COST_BASIS_KINDS], COST_BASIS_ROWS_PER_WALLET + 1, bounds.presaleCheckpoint, bounds.marketCheckpoint,
    ]));
  } catch {
    return null;
  }
  const rows = new Map<string, CostBasisRow[]>();
  const perWallet = new Map<string, number>();
  for (const row of ledger) {
    perWallet.set(row.actor, (perWallet.get(row.actor) ?? 0) + 1);
    const who = holderOfWallet.get(row.actor)!;
    const own = rows.get(who);
    if (own) own.push(row);
    else rows.set(who, [row]);
  }
  const truncated = new Set([...perWallet].flatMap(([wallet, count]) => (count > COST_BASIS_ROWS_PER_WALLET ? [holderOfWallet.get(wallet)!] : [])));
  return { rows, truncated };
}

/** A coin's indexed supply, else (a tracked pool coin) the node's circulating supply from the shared cached read. */
async function chainSupplyOf(coin: CoinRow, context: HoldersReadContext): Promise<string | null> {
  if (coin.supply !== null || !coin.tracked_pool_only || !context.trackedPoolMarket) return coin.supply;
  const markets = await optionalSource("tracked_pool_market", context.trackedPoolMarket, {});
  return markets[coin.coin_type]?.circulatingSupplyAtoms ?? null;
}

/** The coin's holders with their figures, or `not_found` when Home lists no such coin (`COIN_SQL`). */
export async function readHomeHolders(db: ReadableDatabase, coinType: string, limit: number, context: HoldersReadContext): Promise<HomeHoldersPage> {
  const [bounds, asOf, coins] = await Promise.all([readHomeBounds(db, context.nowMs), readAsOf(db), db.read<CoinRow>(COIN_SQL, [coinType])]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const coin = coins.rows[0];
  if (!coin) throw new SocialRouteError("not_found");
  const presaleId = coin.presale_id;
  const facts = { presale_id: presaleId, pool_id: coin.pool_id, launch_id: coin.launch_id, coin_type: coin.coin_type };
  const [holders, terms, chainSupply] = await Promise.all([
    readTopHolders(db, [facts], bounds.clockMs, limit),
    presaleId !== null && context.terms ? context.terms(presaleId) : Promise.resolve(null),
    chainSupplyOf(coin, context),
  ]);
  const rows: readonly HolderRow[] = holders.get(coin.coin_type) ?? [];
  const accountIds = [...new Set(rows.flatMap((row) => (row.account_id === null ? [] : [row.account_id])))];
  const [people, sharing, accountWallets, whys] = await Promise.all([
    readPeople(db, accountIds),
    accountIds.length ? db.read<{ account_id: string }>(SHARING_SQL, [accountIds]) : null,
    accountIds.length && presaleId !== null ? db.read<{ account_id: string; address: string }>(ACCOUNT_WALLETS_SQL, [accountIds]) : null,
    accountIds.length ? db.read<{ account_id: string; text: string }>(HOLDER_WHYS_SQL, [accountIds, presaleId, coin.coin_type, context.hiddenKinds]) : null,
  ]);
  const whyOf = new Map((whys?.rows ?? []).map((row) => [row.account_id, row.text]));
  const walletsOf = walletsOfHolders(rows, new Set((sharing?.rows ?? []).map((row) => row.account_id)), accountWallets?.rows ?? []);
  // Only a sale coin has a basis: the ledger is keyed by the sale (T-038 stamps every trade with it).
  const ledgers = presaleId === null ? null : await readHolderLedgers(db, presaleId, walletsOf, bounds);
  const price: PortfolioPrice | null = coin.price_usd !== null && coin.price_as_of_ms !== null
    ? { usd_price: coin.price_usd, as_of_ms: Number(coin.price_as_of_ms) }
    : null;
  const fresh = isFreshPrice(price ?? undefined, context.nowMs) ? price : null;
  // A sale's supply is in its terms; another coin's is on chain.
  const supply = terms?.supply.total ?? chainSupply;
  const figuresOf = (row: HolderRow) => (presaleId === null || ledgers === null || !walletsOf.has(row.who) || ledgers.truncated.has(row.who)
    ? UNKNOWN_BASIS
    : coinBasisFigures(costBasisBook({ rows: ledgers.rows.get(row.who) ?? [], truncated: false }), presaleId, { balance: row.balance, decimals: coin.sale_decimals, price }, context.nowMs));
  const positions = rows.map((row): HomeHolderPosition => {
    const figures = figuresOf(row);
    return {
      actor: actorOf({ account_id: row.account_id, wallet: row.wallet }, people.identities),
      balance: row.balance,
      share_bps: shareBps(row.balance, supply),
      value_usd: fresh ? atomsToUsd(row.balance, coin.sale_decimals, fresh.usd_price) : null,
      average_entry_usd: figures.basis_complete && figures.basis_usd !== null ? averageEntryUsd(figures.basis_usd, row.balance, coin.sale_decimals) : null,
      why: row.account_id === null ? null : whyOf.get(row.account_id) ?? null,
      ...figures,
    };
  });
  return {
    coin_type: coin.coin_type,
    presale_id: presaleId,
    decimals: coin.sale_decimals,
    price_usd: coin.price_usd,
    price_as_of_ms: coin.price_as_of_ms === null ? null : Number(coin.price_as_of_ms),
    holders: positions,
    as_of: asOf,
  };
}
