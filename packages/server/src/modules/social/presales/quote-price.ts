/**
 * R3-40: a price per whole sale token in the sale's own quote coin, computed
 * exactly from atoms — the presale page's terms, the claims' entry price on a
 * profile — so a SUI sale's price never passes through a float or a dollar.
 */

const PLAIN_ATOMS = /^(0|[1-9][0-9]*)$/;

/**
 * R3-40: quote coin per whole token, exactly — `quoteAtoms` (with the
 * quote's decimals) over `tokenAtoms` (with the sale's), as a plain decimal
 * rounded half up to 12 significant digits, trailing zeros dropped; null for
 * a zero or malformed side. Integers only: no float touches the price.
 */
export function quotePerToken(
  quoteAtoms: bigint,
  quoteDecimals: number,
  tokenAtoms: string,
  saleDecimals: number,
): string | null {
  if (!PLAIN_ATOMS.test(tokenAtoms) || quoteAtoms <= 0n) return null;
  const tokens = BigInt(tokenAtoms);
  if (tokens <= 0n) return null;
  // price = quoteAtoms · 10^sale / (tokens · 10^quote); carried at `places` fraction digits.
  const numerator = quoteAtoms * 10n ** BigInt(saleDecimals);
  const denominator = tokens * 10n ** BigInt(quoteDecimals);
  const whole = numerator / denominator;
  const leading = whole > 0n ? 0 : (() => {
    // Leading zeros after the point before the first significant digit.
    let zeros = 0;
    let rest = numerator * 10n;
    while (rest < denominator) {
      zeros += 1;
      rest *= 10n;
    }
    return zeros;
  })();
  const significant = 12;
  const places = Math.max(0, whole > 0n ? significant - whole.toString().length : leading + significant);
  const scaled = numerator * 10n ** BigInt(places);
  let digits = scaled / denominator;
  if ((scaled % denominator) * 2n >= denominator) digits += 1n;
  const text = digits.toString().padStart(places + 1, "0");
  const fixed = places === 0 ? text : `${text.slice(0, -places)}.${text.slice(-places)}`;
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}
