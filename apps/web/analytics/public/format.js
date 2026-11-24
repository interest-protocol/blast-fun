/** Exact display/copy never uses floating-point money. Only plot coordinates are approximate. */
export const integer = (value) => BigInt(value).toLocaleString("en-US");
export function decimal(value) {
  const [whole, fraction = ""] = String(value).split(".");
  return `${integer(whole)}${fraction ? `.${fraction}` : ""}`;
}
export function compact(value, money = false) {
  const [whole, fraction = ""] = String(value).split(".");
  if (whole.length > 21)
    return `${money ? "$" : ""}${whole.length} digits · inspect`;
  const amount = BigInt(whole);
  for (const [limit, suffix] of [
    [1_000_000_000_000_000_000n, " quintillion"],
    [1_000_000_000_000_000n, "P"],
    [1_000_000_000_000n, "T"],
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
  ]) {
    if (amount >= limit)
      return `${money ? "$" : ""}${integer(amount / limit)}.${((amount % limit) * 10n) / limit}${suffix}`;
  }
  if (money && amount === 0n && /^00/.test(fraction) && /[1-9]/.test(fraction))
    return "<$0.01";
  return `${money ? "$" : ""}${integer(whole)}${money ? `.${fraction.padEnd(2, "0").slice(0, 2)}` : ""}`;
}
export function timestamp(value) {
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) return null;
  const exact = BigInt(value);
  // Keep Date and the chart in the common four-digit UTC year range.
  return exact <= 253_402_300_799_999n ? Number(exact) : null;
}
export function utc(value) {
  const milliseconds = timestamp(value);
  return milliseconds === null
    ? `${value} ms since Unix epoch`
    : `${new Date(milliseconds).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })} UTC`;
}
export function day(value) {
  const milliseconds = timestamp(value);
  return milliseconds === null
    ? `${value} ms since Unix epoch`
    : new Date(milliseconds).toISOString().slice(0, 10);
}
export function chartRows(rows) {
  const scale = Math.max(
    0,
    ...rows.map((row) => (row.priced_usd.split(".")[1] ?? "").length),
  );
  const atoms = rows.map((row) => {
    const [whole, fraction = ""] = row.priced_usd.split(".");
    return BigInt(whole + fraction.padEnd(scale, "0"));
  });
  const maximum = atoms.reduce((a, b) => (a > b ? a : b), 0n);
  if (rows.some((row) => timestamp(row.day_ms) === null)) return null;
  // One point per exact table row; absent days remain gaps, not invented zero volume.
  const result = rows.map((row, index) => ({
    time: Number(BigInt(row.day_ms) / 1000n),
    value: maximum
      ? Number((atoms[index] * 1_000_000n) / maximum) / 1_000_000
      : 0,
  }));
  result.sort((a, b) => a.time - b.time);
  if (
    result.some(
      (row, index) => index > 0 && row.time === result[index - 1].time,
    )
  )
    return null;
  return result;
}
