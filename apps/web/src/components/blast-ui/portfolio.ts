/** Owner-only portfolio figures shared by the persistent account bar and trading UI. */
export type TodayMove = Readonly<{ usd: number; pct: number }>;

export type PortfolioSummary = Readonly<{
  /** Complete USD value; null when holdings or any required price are unavailable. */
  total_usd: number | null;
  /** Available USD subtotal when unpriced assets make the complete total unknown. */
  known_value_usd?: number;
  /** Holdings were read successfully, but at least one held asset has no USD valuation. */
  unpriced_assets?: true;
  /** Today's move; null unless every input is known. */
  today: TodayMove | null;
  /** The same categories as the Portfolio page; absent until its read arrives. */
  breakdown?: Readonly<{ coins: number | null; committed: number | null; claimable: number | null }>;
  /** With `unpriced_assets`: each category's priced part, which add up to `known_value_usd`. */
  known_breakdown?: Readonly<{ coins: number; committed: number; claimable: number }>;
}>;

export type PortfolioSummaryState =
  /** Reading: the header shows a loading label. */
  | Readonly<{ status: "loading" }>
  /** No account yet, a refusal or a failed read. */
  | Readonly<{ status: "unavailable" }>
  | Readonly<{ status: "ready"; summary: PortfolioSummary }>;

export const PORTFOLIO_UNAVAILABLE: PortfolioSummaryState = Object.freeze({ status: "unavailable" });
export const PORTFOLIO_LOADING: PortfolioSummaryState = Object.freeze({ status: "loading" });

/** `atoms` / 10^`decimals` as a number, exact to the cent for any u64. */
export function atomsToUnits(atoms: string, decimals: number): number {
  const value = BigInt(atoms);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const cents = ((value % scale) * 100n) / scale;
  return Number(whole) + Number(cents) / 100;
}
