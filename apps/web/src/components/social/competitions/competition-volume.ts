

/**
 * The board's volume: whole dollars with separators (`$1,284,120`), the exact
 * recorded value one inspection away. A nonzero volume under a dollar reads
 * `<$1`, never `$0`.
 */
export function wholeUsd(value: string): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const dollars = BigInt(whole);
  if (dollars === 0n && /[1-9]/.test(fraction)) return "<$1";
  return `$${dollars.toLocaleString("en-US")}`;
}
