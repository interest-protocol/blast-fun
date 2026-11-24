import {
  fromAbsolute,
  parseDateTime,
  parseZonedDateTime,
  toZoned,
} from "@internationalized/date";
import {
  linearVestedAt,
  validateCheckpointSchedule,
  validateLinearSchedule,
} from "@interest-protocol/blast-util-sdk/vesting";
import {
  createVestingSchema,
  formatVestingAmount,
  parseVestingAmount,
  type CreateVesting,
} from "@blast/core/modules/vesting/model.ts";
import {
  SUI_FEE_RESERVE_ATOMS,
} from "#web/components/social/coins/coin-model.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

const DAY = 86_400_000n;
export type Release = Readonly<{ key: string; date: string; amount: string }>;
export type ScheduleInput = Readonly<{
  kind: "linear" | "checkpoints";
  start: string;
  end: string;
  cliffDays: string;
  periodDays: string;
  periods: string;
  releases: readonly Release[];
  decimals: number;
}>;
export type CreationInput = ScheduleInput &
  Readonly<{
    coinType: string;
    total: string;
    beneficiary: string;
    cancelable: boolean;
    refund: string;
    capRecipient: string;
  }>;
export class CreationFieldError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

function integer(text: string, field: string, minimum: bigint): bigint {
  if (
    !/^\d+$/.test(text) ||
    BigInt(text) < minimum ||
    BigInt(text) > 18_446_744_073_709_551_615n
  )
    throw new CreationFieldError(
      field,
      `Enter a whole number of at least ${minimum}.`,
    );
  return BigInt(text);
}

export function releaseTimestamp(
  text: string,
  field: string,
  timezone = "UTC",
): bigint {
  try {
    const date = text.includes("[")
      ? parseZonedDateTime(text, "reject")
      : toZoned(parseDateTime(text), timezone, "reject");
    const value = date.toDate().getTime();
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError();
    return BigInt(value);
  } catch {
    throw new CreationFieldError(
      field,
      `Choose a valid date and time in ${timezone}. For a time in another zone, include its zone and explicit UTC offset.`,
    );
  }
}

export function amountAtoms(
  text: string,
  decimals: number,
  field = "total",
): bigint {
  try {
    return BigInt(parseVestingAmount(text, decimals));
  } catch {
    throw new CreationFieldError(
      field,
      `Enter a positive amount with up to ${decimals} decimal places.`,
    );
  }
}

/** The preview and transaction intent share this exact construction and SDK validation. */
export function createSchedule(
  input: ScheduleInput,
  total: bigint,
  now = BigInt(Date.now()),
): CreateVesting["schedule"] {
  if (input.kind === "linear") {
    const start = releaseTimestamp(input.start, "start");
    const end = releaseTimestamp(input.end, "end");
    if (end <= start)
      throw new CreationFieldError("end", "Choose an end after the start.");
    const schedule = {
      startMs: start,
      // An empty cliff is no cliff: the box starts empty so typing never joins a "0" (#1012).
      cliffMs: integer(input.cliffDays.trim() || "0", "cliff", 0n) * DAY,
      // At Sui Clock's millisecond precision this is exactly total * elapsed / duration.
      periodMs: 1n,
      periods: end - start,
    };
    if (schedule.startMs < now + 60_000n)
      throw new CreationFieldError(
        "start",
        "Choose a start at least one minute in the future.",
      );
    if (schedule.cliffMs > schedule.periodMs * schedule.periods)
      throw new CreationFieldError(
        "cliff",
        "The cliff cannot end after vesting ends.",
      );
    try {
      validateLinearSchedule(schedule, now);
    } catch {
      throw new CreationFieldError(
        "end",
        "This schedule exceeds the supported duration.",
      );
    }
    return {
      kind: "linear",
      start_ms: String(schedule.startMs),
      cliff_ms: String(schedule.cliffMs),
      period_ms: String(schedule.periodMs),
      periods: String(schedule.periods),
    };
  }
  if (input.releases.length < 1 || input.releases.length > 256)
    throw new CreationFieldError("releases", "Choose 1–256 releases.");
  let cumulative = 0n;
  let previous = 0n;
  const checkpoints = input.releases.map((release, index) => {
    const time = releaseTimestamp(release.date, `date-${release.key}`);
    if (index === 0 && time < now + 60_000n)
      throw new CreationFieldError(
        `date-${release.key}`,
        "Choose a release at least one minute in the future.",
      );
    if (time <= previous)
      throw new CreationFieldError(
        `date-${release.key}`,
        "Each release must be later than the previous one.",
      );
    previous = time;
    cumulative += amountAtoms(
      release.amount,
      input.decimals,
      `amount-${release.key}`,
    );
    return { timestampMs: time, cumulativeAmount: cumulative };
  });
  if (cumulative !== total)
    throw new CreationFieldError(
      "releases",
      "Release amounts must add up to the entire locked amount.",
    );
  validateCheckpointSchedule(checkpoints, total, now);
  return {
    kind: "checkpoints",
    checkpoints: checkpoints.map((point) => ({
      timestamp_ms: String(point.timestampMs),
      cumulative_amount: String(point.cumulativeAmount),
    })),
  };
}

export function createIntent(
  input: CreationInput,
  now = BigInt(Date.now()),
): CreateVesting {
  const total = amountAtoms(input.total, input.decimals);
  for (const [field, address] of [
    ["beneficiary", input.beneficiary],
    ...(input.cancelable
      ? [
          ["refund", input.refund],
          ["capRecipient", input.capRecipient],
        ]
      : []),
  ]) {
    if (
      !/^0x[\da-f]{64}$/i.test(address!.trim()) ||
      /^0x0{64}$/i.test(address!.trim())
    )
      throw new CreationFieldError(
        field!,
        "Enter a full Sui address: 0x followed by 64 hexadecimal characters.",
      );
  }
  return createVestingSchema.parse({
    action: "create",
    coinType: input.coinType,
    total: String(total),
    beneficiary: input.beneficiary.trim(),
    refundRecipient: input.cancelable ? input.refund.trim() : null,
    cancelCapRecipient: input.cancelable ? input.capRecipient.trim() : null,
    schedule: createSchedule(input, total, now),
  });
}

export function linearReleaseSummary(
  schedule: Extract<CreateVesting["schedule"], { kind: "linear" }>,
  total: bigint,
) {
  const state = {
    startMs: BigInt(schedule.start_ms),
    cliffMs: BigInt(schedule.cliff_ms),
    periodMs: BigInt(schedule.period_ms),
    periods: BigInt(schedule.periods),
  };
  const firstNonzeroPeriod = (state.periods + total - 1n) / total;
  const firstStep = state.startMs + state.periodMs * firstNonzeroPeriod;
  const cliffEnd = state.startMs + state.cliffMs;
  const first = firstStep > cliffEnd ? firstStep : cliffEnd;
  const final = state.startMs + state.periodMs * state.periods;
  return {
    start: state.startMs,
    first,
    final,
    firstAmount: linearVestedAt(total, state, first),
    cliffEnd,
  };
}

/** Equal, dated tranches use the checkpoint contract, including exact atom remainders. */
export function regularCheckpointReleases(
  input: ScheduleInput,
  total: bigint,
  timezone = "UTC",
): readonly Release[] {
  const count = integer(input.periods, "periods", 1n);
  if (count > 256n)
    throw new CreationFieldError("periods", "Choose 1–256 checkpoints.");
  const start = releaseTimestamp(input.start, "start");
  const interval = integer(input.periodDays, "interval", 1n) * DAY;
  const amounts = splitReleaseAtoms(total, Number(count));
  return amounts.map((amount, index) => {
    const time = start + interval * BigInt(index + 1);
    if (time > 8_640_000_000_000_000n)
      throw new CreationFieldError("periods", "Choose a shorter schedule.");
    return {
      key: `regular-${index}`,
      // Keep the instant and UTC offset through DST changes and local editing.
      date: fromAbsolute(Number(time), timezone).toString(),
      amount: formatVestingAmount(amount, input.decimals),
    };
  });
}

/** First rows receive one extra atom; every row remains positive and sums exactly. */
export function splitReleaseAtoms(
  total: bigint,
  count: number,
): readonly bigint[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 256 ||
    total < BigInt(count)
  )
    throw new Error("Each release needs at least one atomic unit.");
  const rows = BigInt(count);
  return Array.from(
    { length: count },
    (_, index) => total / rows + (BigInt(index) < total % rows ? 1n : 0n),
  );
}

export function maxVestingAtoms(
  coinType: string,
  balance: bigint,
  sponsored = false,
): bigint {
  return !sponsored && coinType === SUI_COIN_TYPE
    ? balance > SUI_FEE_RESERVE_ATOMS
      ? balance - SUI_FEE_RESERVE_ATOMS
      : 0n
    : balance;
}

export function vestingPortionAtoms(
  coinType: string,
  balance: bigint,
  percent: 25 | 50 | 75,
  sponsored = false,
): bigint {
  return (
    (maxVestingAtoms(coinType, balance, sponsored) * BigInt(percent)) / 100n
  );
}
