import {
  isContinuousLinear,
  type VestingTerms,
} from "@blast/core/modules/vesting/model.ts";

export const MAX_DATE_MS = 8_640_000_000_000_000n;

export function vestingScheduleLabel(terms: VestingTerms): string {
  if (isContinuousLinear(terms)) return "Linear vesting";
  return terms.kind === "checkpoints"
    ? "Checkpoint vesting"
    : "Stepped vesting";
}
export function vestingDate(value: bigint | string): string {
  const ms = BigInt(value);
  if (ms > MAX_DATE_MS) return `Unix ${ms} ms`;
  return new Date(Number(ms))
    .toISOString()
    .replace("T", " ")
    .replace(/:00\.000Z$/, " UTC")
    .replace(".000Z", " UTC")
    .replace(/Z$/, " UTC");
}
export function scheduleBounds(
  terms: VestingTerms,
): readonly [bigint, bigint] | null {
  if (terms.kind === "checkpoints") {
    if (!terms.checkpoints) return null;
    return [
      BigInt(terms.checkpoints[0]!.timestamp_ms),
      BigInt(terms.checkpoints.at(-1)!.timestamp_ms),
    ];
  }
  const start = BigInt(terms.start_ms);
  return [start, start + BigInt(terms.period_ms) * BigInt(terms.periods)];
}
export function releaseInterval(ms: string): string {
  const value = BigInt(ms);
  for (const [size, unit] of [
    [86400000n, "day"],
    [3600000n, "hour"],
    [60000n, "minute"],
    [1000n, "second"],
  ] as const) {
    if (value % size === 0n) {
      const count = value / size;
      return `${count} ${unit}${count === 1n ? "" : "s"}`;
    }
  }
  return `${value} ms`;
}
