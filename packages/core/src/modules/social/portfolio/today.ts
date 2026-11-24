/** One held trading coin's day: what is held, the price now and the day's open (R3-20). */
export type DayCoin = Readonly<{ held: number; now: number; dayOpen: number }>;

/**
 * Today's move (the gate's `dockToday`): `Σ held × (now − dayOpen)` over the
 * trading coins held, plus SUI's 24 h move, as a percentage of the opening
 * value. **Null unless every input is known**: a day-open price per coin and
 * SUI's 24 h change (R3-20), and the total; then the `today` line is absent
 * and the total keeps its width.
 */
export function todayMove(
  coins: readonly DayCoin[] | null,
  sui: Readonly<{ usd: number; change24hPct: number }> | null,
  total: number | null,
): Readonly<{ usd: number; pct: number }> | null {
  if (coins === null || sui === null || total === null) return null;
  let usd = 0;
  for (const coin of coins) usd += coin.held * (coin.now - coin.dayOpen);
  const change = sui.change24hPct / 100;
  usd += sui.usd - sui.usd / (1 + change);
  const base = total - usd;
  if (!Number.isFinite(usd)) return null;
  return { usd, pct: base > 0 ? (usd / base) * 100 : 0 };
}
