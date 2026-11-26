import { formatVestingAmount } from "@blast/core/modules/vesting/model.ts";

/** Display only: truncate a bigint scaled to four places, without Number conversion. */
export function compactVestingAmount(atoms: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  for (const [units, suffix] of [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ] as const) {
    if (atoms >= scale * units) {
      const digits = (atoms * 10_000n) / (scale * units);
      const fraction = String(digits % 10_000n)
        .padStart(4, "0")
        .replace(/0+$/, "");
      return `≈ ${digits / 10_000n}${fraction ? `.${fraction}` : ""}${suffix}`;
    }
  }
  return formatVestingAmount(atoms, decimals);
}

const summaryFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Short UTC date for the live summary, e.g. "4 Dec 2026, 12:00". */
export function summaryDate(value: bigint | string): string {
  const ms = BigInt(value);
  if (ms > 8_640_000_000_000_000n) return `Unix ${ms} ms`;
  return summaryFormat.format(new Date(Number(ms)));
}

/** Group only whole digits; token precision never passes through Number. */
export function reviewVestingAmount(value: bigint | string, decimals: number | null): string {
  const [whole, fraction] = formatVestingAmount(value, decimals).split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}
