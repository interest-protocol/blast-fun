import { pct1, pct1Digits } from "./post-format";

/**
 * Today's moves of the coins that trade (R3-83, oa41's `whyNow`): each sale
 * coin's 24 h change and SUI's (R3-20's `change_24h_bps`), and the gainers —
 * the coins up today, the biggest move first (the gate's
 * `topCoins('gainers')`). `change` is keyed by presale id, SUI by `"sui"`.
 */
export type CoinMoves = Readonly<{ change: ReadonlyMap<string, number>; gainers: readonly string[] }>;

/** The moves from each coin's change in percent: the gainers are the ones above zero, largest first. */
export function coinMovesOf(change: ReadonlyMap<string, number>): CoinMoves {
  const gainers = [...change].filter(([, pct]) => pct > 0).sort((a, b) => b[1] - a[1]).map(([key]) => key);
  return { change, gainers };
}

/**
 * The line above a buy that says why its coin is worth a look now (the gate's
 * `whyNow`): `Top gainer today · +32.6%` for the day's top gainer, `Up 6.2%
 * today` for the second and third. The gate's `Trending · N bought today`
 * needs Blast's own buyer counts per coin (R3-78), which no read serves yet,
 * so it is left out (a trending coin that is also a gainer reads its gain).
 * Null when the coin is none of these or its move is unknown.
 */
export function whyNowLine(presaleId: string, moves: CoinMoves | null): string | null {
  const change = moves?.change.get(presaleId);
  if (!moves || change === undefined) return null;
  const rank = moves.gainers.indexOf(presaleId);
  if (rank === 0) return `Top gainer today · ${pct1(change)}`;
  if (rank === 1 || rank === 2) return `Up ${pct1Digits(change)}% today`;
  return null;
}
