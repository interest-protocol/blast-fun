import { formatVestingAmount } from "@blast/core/modules/vesting/model.ts";
import { MAX_DATE_MS, vestingDate } from "./schedule-display";
import { displayVestingAmount } from "./amount-display";

export function exactAmount(
  value: bigint | string,
  decimals: number | null,
): string {
  const raw = formatVestingAmount(value, decimals);
  const [whole, fraction] = raw.replace(/ atoms$/, "").split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${grouped}${fraction ? `.${fraction}` : ""}${decimals === null ? " atoms" : ""}`;
}

export function compactAmount(
  value: bigint | string,
  decimals: number | null,
): string {
  const atoms = BigInt(value);
  const unit = 10n ** BigInt(decimals ?? 0);
  for (const [scale, suffix] of [
    [1_000_000_000_000_000_000n, "E"],
    [1_000_000_000_000_000n, "Q"],
    [1_000_000_000_000n, "T"],
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
  ] as const) {
    if (atoms >= scale * unit) {
      const hundredths = (atoms * 100n + (scale * unit) / 2n) / (scale * unit);
      return `≈ ${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}${suffix}${decimals === null ? " atoms" : ""}`;
    }
  }
  return readableAmount(value, decimals);
}

export function readableAmount(
  value: bigint | string,
  decimals: number | null,
): string {
  const short = displayVestingAmount(value, decimals);
  return short === exactAmount(value, decimals) || short.startsWith("<")
    ? short
    : `≈ ${short}`;
}

const utcDateOptions = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
} as const;

const utcDateFormat = new Intl.DateTimeFormat("en-GB", utcDateOptions);

const utcSecondsFormat = new Intl.DateTimeFormat("en-GB", {
  ...utcDateOptions,
  second: "2-digit",
});

const utcMillisFormat = new Intl.DateTimeFormat("en-GB", {
  ...utcDateOptions,
  second: "2-digit",
  fractionalSecondDigits: 3,
});

export function readableDate(value: bigint | string): string {
  const ms = BigInt(value);
  if (ms > MAX_DATE_MS) return vestingDate(value);
  const format =
    ms % 1000n !== 0n
      ? utcMillisFormat
      : ms % 60_000n !== 0n
        ? utcSecondsFormat
        : utcDateFormat;
  return `${format.format(new Date(Number(ms)))} UTC`;
}
