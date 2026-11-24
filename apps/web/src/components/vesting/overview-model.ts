import { HIDDEN_AMOUNT } from "@blast/core/lib/format.ts";
import { vestingAmounts, type PublicVesting } from "@blast/core/modules/vesting/model.ts";
import { exactAmount } from "./detail-format";
import { isContinuousSchedule, releaseAfter, scheduleState } from "./detail-schedule";
import { scheduleBounds } from "./schedule-display";

function scheduleTiming(schedule: PublicVesting, now: bigint, amounts: ReturnType<typeof vestingAmounts>) {
  if (schedule.status !== "active") return { label: "Future releases", text: "No future releases", at: null };
  if (!amounts) return { label: "Timing", text: "Schedule data unavailable", at: null };
  const next = releaseAfter(schedule, now);
  if (!next) return { label: "Unlocks", text: "No remaining unlocks", at: null };
  if (isContinuousSchedule(schedule) && amounts.vested > 0n) {
    return { label: "Unlocking continuously", text: "Fully unlocked", at: scheduleBounds(schedule.terms)?.[1] ?? null };
  }
  return { label: amounts.vested === 0n ? "First release" : "Next release", text: null, at: next.time };
}

/** Financial facts use the same clock and SDK projection as the schedule detail. */
export function overviewSchedule(schedule: PublicVesting, nowMs: number, hidden: boolean) {
  const now = BigInt(nowMs);
  const amounts = vestingAmounts(schedule, now);
  const total = BigInt(schedule.total);
  const amount = (value: bigint | string | undefined) => hidden
    ? HIDDEN_AMOUNT
    : value === undefined ? "—" : exactAmount(value, schedule.coin_decimals);
  const progress = !hidden && amounts && schedule.status === "active" && total > 0n
    ? Number(amounts.vested) / Number(total) * 100
    : null;
  const hundredths = amounts && total > 0n ? amounts.vested * 10_000n / total : null;
  const progressText = hundredths === null ? "Unlocked amount unavailable"
    : hundredths === 0n && amounts!.vested > 0n ? "<0.01% unlocked"
      : `${Number(hundredths) / 100}% unlocked`;
  return {
    symbol: schedule.coin_symbol ?? schedule.coin_type.split("::").at(-1) ?? "coin",
    name: schedule.coin_name ?? schedule.coin_symbol ?? schedule.coin_type.split("::").at(-1) ?? "Vesting",
    state: scheduleState(schedule, now),
    available: amount(amounts?.releasable),
    allocated: amount(schedule.total),
    claimed: amount(schedule.released),
    remaining: amount(total - BigInt(schedule.released) - BigInt(schedule.refunded)),
    balances: {
      claimed: BigInt(schedule.released),
      remaining: total - BigInt(schedule.released) - BigInt(schedule.refunded),
      available: amounts?.releasable,
    },
    unlocked: amount(schedule.status === "active" ? amounts?.vested : undefined),
    progress,
    progressText: hidden ? "Amounts hidden" : progressText,
    timing: scheduleTiming(schedule, now, amounts),
  };
}
