import { chainPriceOf } from "@blast/core/modules/social/prices/keyed.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE, TEST_SUI_COIN_TYPES, createQuoteOf } from "@blast/core/modules/social/contracts/create.ts";
import { verifiedTeamSql } from "@blast/server/modules/social/read-model/verified-team.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { BLAST_LAUNCH_COINS } from "../read-model/blast-launch-coins.ts";
import { atomsToUsd, atomsToUsdExact, isFreshPrice, PORTFOLIO_COIN_TYPES, type PortfolioPrice } from "@blast/core/modules/social/portfolio/read.ts";

export type WalletSync = Readonly<{ status: "ready" | "syncing" | "stale"; checkpoint: string | null; as_of_ms: number | null }>;
export type WalletHolding = Readonly<{
  coin_type: string;
  balance: string;
  name: string | null;
  symbol: string;
  decimals: number | null;
  icon_url: string | null;
  presale_id: string | null;
  launch_id?: string;
  /** Blast checked who is behind the coin: its sale's or its curve's flag (`verifiedTeamSql`). */
  verified_team?: boolean;
  price: PortfolioPrice | null;
  priceUnavailable: boolean;
}>;
export type WalletHoldings = Readonly<{ holdings: readonly WalletHolding[]; sync: WalletSync }>;

type Row = {
  owner: string; status: WalletSync["status"] | null; checkpoint: string | null; timestamp_ms: string | null;
  coin_type: string | null; balance: string | null; name: string | null; symbol: string | null;
  decimals: number | null; icon_url: string | null; presale_id: string | null; usd_price: string | null; as_of_ms: string | null;
  price_unavailable: boolean | null; launch_id: string | null; verified_team: boolean | null;
};

const WALLET_HOLDINGS_SQL = `SELECT w.owner, s.status, s.checkpoint::text, s.timestamp_ms::text,
    b.coin_type, b.balance::text, coalesce(m.name,c.name) AS name, coalesce(m.symbol,c.symbol) AS symbol,
    coalesce(m.decimals,c.decimals)::int AS decimals, coalesce(m.icon_url,c.icon_url) AS icon_url, c.presale_id, c.launch_id,
    ${verifiedTeamSql("c.presale_id", "b.coin_type")} AS verified_team,
    pr.usd_price::text, pr.as_of_ms::text,
    EXISTS (SELECT 1 FROM chain_read_v1.coin_unavailable WHERE coin_type = b.coin_type)
      OR (pr.coin_type IS NULL AND (b.coin_type = ANY($2::text[])
        OR (c.pool_id IS NOT NULL AND c.quote_type = ANY($2::text[])))) AS price_unavailable
    FROM (SELECT DISTINCT unnest((SELECT $1::text[])) AS owner) w
    LEFT JOIN chain_read_v1.wallet_sync s USING (owner)
    LEFT JOIN chain_read_v1.wallet_balances b USING (owner)
    LEFT JOIN LATERAL (SELECT * FROM chain_read_v1.coin_metadata WHERE coin_type = b.coin_type OFFSET 0) m ON TRUE
    LEFT JOIN ${chainPriceOf("b.coin_type")} pr ON TRUE
    LEFT JOIN LATERAL (SELECT * FROM ${BLAST_LAUNCH_COINS} c WHERE c.coin_type = b.coin_type LIMIT 1) c ON TRUE`;

const DISPLAY_QUOTE_TYPES = [...Object.values(PORTFOLIO_COIN_TYPES), CREATE_TEST_SUI_QUOTE_TYPE];

/** One database snapshot, including empty and not-yet-synchronized wallets. Prices never filter holdings. */
export async function readWalletHoldings(db: ReadableDatabase, wallets: readonly string[]): Promise<WalletHoldings> {
  if (wallets.length === 0) return { holdings: [], sync: { status: "ready", checkpoint: null, as_of_ms: null } };
  // The InitPlan keeps wallet-array estimates stable so prepared reads reuse the indexed plan.
  // Keep metadata lookups per held coin; flattening this view scans the whole coin catalog.
  const { rows } = await db.read<Row>(WALLET_HOLDINGS_SQL, [[...wallets], DISPLAY_QUOTE_TYPES]);
  return holdingsOf(rows);
}

function holdingsOf(rows: readonly Row[]): WalletHoldings {
  const holdings = new Map<string, WalletHolding>();
  for (const row of rows) {
    if (!row.coin_type || !row.balance) continue;
    const balance = (BigInt(holdings.get(row.coin_type)?.balance ?? "0") + BigInt(row.balance)).toString();
    const testSui = TEST_SUI_COIN_TYPES.includes(row.coin_type);
    holdings.set(row.coin_type, {
      coin_type: row.coin_type, balance, name: row.name, symbol: row.symbol ?? row.coin_type.split("<", 1)[0]?.split("::").at(-1) ?? row.coin_type,
      decimals: row.decimals ?? createQuoteOf(row.coin_type)?.decimals ?? null, icon_url: row.icon_url, presale_id: row.presale_id, ...(row.launch_id ? { launch_id: row.launch_id } : {}), ...(row.verified_team === true ? { verified_team: true } : {}),
      price: testSui || row.usd_price === null || row.as_of_ms === null ? null : { usd_price: row.usd_price, as_of_ms: Number(row.as_of_ms) },
      priceUnavailable: !testSui && row.price_unavailable === true,
    });
  }
  return { holdings: [...holdings.values()], sync: walletSync(rows) };
}

/** Bounded callers (Home uses four accounts) avoid one holdings round trip per account. */
export async function readWalletHoldingsBatch(db: ReadableDatabase, accounts: ReadonlyMap<string, readonly string[]>): Promise<ReadonlyMap<string, WalletHoldings>> {
  const result = new Map<string, WalletHoldings>();
  if (accounts.size === 0) return result;
  const { rows } = await db.read<Row & { account_id: string }>(
    `SELECT selected.account_id, holding.*
     FROM jsonb_to_recordset($1::jsonb) AS selected(account_id text, addresses text[])
     CROSS JOIN LATERAL (${WALLET_HOLDINGS_SQL.replace("$1::text[]", "selected.addresses")}) holding`,
    [JSON.stringify([...accounts].map(([account_id, addresses]) => ({ account_id, addresses }))), DISPLAY_QUOTE_TYPES],
  );
  const grouped = new Map<string, Row[]>([...accounts.keys()].map((id) => [id, []]));
  for (const row of rows) grouped.get(row.account_id)!.push(row);
  for (const [id, values] of grouped) result.set(id, holdingsOf(values));
  return result;
}

function walletSync(rows: readonly Row[]): WalletSync {
  let status: WalletSync["status"] = "ready";
  let checkpoint: bigint | null = null;
  let asOf: number | null = null;
  for (const row of rows) {
    if (row.status === "stale") status = "stale";
    else if (row.status !== "ready" && status !== "stale") status = "syncing";
    if (row.checkpoint !== null) {
      const at = BigInt(row.checkpoint);
      if (checkpoint === null || at < checkpoint) checkpoint = at;
    }
    if (row.timestamp_ms !== null) asOf = Math.min(asOf ?? Infinity, Number(row.timestamp_ms));
  }
  return { status, checkpoint: status === "ready" ? checkpoint?.toString() ?? null : null, as_of_ms: asOf };
}

export function walletHoldingValue(holding: WalletHolding, nowMs: number): string | null {
  if (holding.balance === "0" || TEST_SUI_COIN_TYPES.includes(holding.coin_type)) return "0.00";
  if (holding.priceUnavailable) return null;
  if (holding.price === null) return null;
  return holding.decimals !== null && isFreshPrice(holding.price, nowMs)
    ? atomsToUsd(holding.balance, holding.decimals, holding.price.usd_price) : null;
}

/** Display precision is separate from the cents used by totals and cost-basis calculations. */
export function walletHoldingExactValue(holding: WalletHolding, nowMs: number): string | null {
  if (holding.balance === "0" || TEST_SUI_COIN_TYPES.includes(holding.coin_type)) return "0";
  if (holding.priceUnavailable || holding.price === null || holding.decimals === null || !isFreshPrice(holding.price, nowMs)) return null;
  return atomsToUsdExact(holding.balance, holding.decimals, holding.price.usd_price);
}

/** The old cash fields remain a partition of the same wallet snapshot, never a second chain read. */
export function walletCash(wallet: WalletHoldings): { sui: string; usdc: string } | null {
  if (wallet.sync.status !== "ready") return null;
  const balances = new Map(wallet.holdings.map((holding) => [holding.coin_type, holding.balance]));
  return { sui: balances.get(PORTFOLIO_COIN_TYPES.sui) ?? "0", usdc: balances.get(PORTFOLIO_COIN_TYPES.usdc) ?? "0" };
}
