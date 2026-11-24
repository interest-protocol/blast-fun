/** Browser-safe catalog choices. Search is a literal case-insensitive substring of name/ticker,
 * or an exact launch ID / coin type. Every selection is paginated on the reader. */
export type BondingStage = "bonding" | "graduated" | "all";
export type BondingSort = "progress" | "newest";
export const GRADUATED_MARKET_CAP_CATALOG = "graduated-market-cap";
export const GRADUATED_MARKET_CAP_PATH = `/api/launchpad/discovery?catalog=${GRADUATED_MARKET_CAP_CATALOG}`;
export const HOME_BONDING_ROWS = 10;

export function normalizeBondingSearch(raw: string): string | null {
  const term = raw
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/^[$@]+/u, "")
    .trim();
  return new TextEncoder().encode(term).length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(term)
    ? term
    : null;
}
