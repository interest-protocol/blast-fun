import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { todayMove } from "@blast/core/modules/social/portfolio/today.ts";
import { changeBps } from "@blast/core/modules/social/prices/change.ts";
import { dayOpenAt, PORTFOLIO_PRICE_FIGURES_SQL } from "@blast/server/modules/social/prices/history.ts";

/** Keep all-wallet totals without sending every holding or fetching their chart series. */
export async function summarizePortfolio(db: ReadableDatabase, portfolio: SocialPortfolio, nowMs: number): Promise<SocialPortfolio> {
  const coins = (portfolio.coins ?? []).filter((coin) => coin.balance !== "0");
  const cents = coins.reduce((sum, coin) => sum + BigInt((coin.value_usd ?? "0.00").replace(".", "")), 0n);
  const known = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  const value = portfolio.coins === null || coins.some((coin) => coin.value_usd === null) ? null : known;
  let today = null;
  const balances = portfolio.balances;
  const commitments = portfolio.commitments;
  if (value !== null && balances?.sui.usd !== null && balances && commitments?.committed_usd !== null && commitments?.claimable_usd !== null && commitments) {
    const total = Number(value) + Number(balances.sui.usd) + Number(balances.usdc.atoms) / 1e6 + Number(commitments.committed_usd) + Number(commitments.claimable_usd);
    try {
      const { rows } = await db.read<{ ord: number; price_usd: string | null; at_24h: string | null; at_day_open: string | null }>(
        PORTFOLIO_PRICE_FIGURES_SQL, [[PORTFOLIO_COIN_TYPES.sui, ...coins.map((coin) => coin.coin_type)], nowMs - 86_400_000, dayOpenAt(nowMs)],
      );
      const byOrder = new Map(rows.map((row) => [row.ord, row]));
      const sui = byOrder.get(1);
      const change = changeBps(sui?.price_usd ?? null, sui?.at_24h?.split(" ")[1] ?? null);
      const days = coins.map((coin, index) => {
        const row = byOrder.get(index + 2);
        const current = Number(row?.price_usd ?? 0);
        const open = row?.at_day_open?.split(" ")[1];
        return current > 0 && open !== undefined ? { held: Number(coin.value_usd) / current, now: current, dayOpen: Number(open) } : null;
      });
      today = todayMove(days.every((day) => day !== null) ? days : null,
        change === null ? null : { usd: Number(balances.sui.usd), change24hPct: change / 100 }, total);
    } catch {
      // Missing history must not hide independently known portfolio totals.
    }
  }
  const exact = coins.reduce((sum, coin) => sum + (Number(coin.value_usd) || Number(coin.value_usd_exact ?? 0)), 0);
  return { ...portfolio, coins: portfolio.coins === null ? null : [], coin_summary: { value_usd: value, known_value_usd: known, has_priced_holdings: coins.some(coin => coin.value_usd !== null), ...(exact > Number(known) ? { known_value_usd_exact: exact } : {}), today } };
}
