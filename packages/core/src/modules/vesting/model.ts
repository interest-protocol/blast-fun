import { mainnet } from "@interest-protocol/blast-util-sdk/deployments";
import type { publicVestingSchema, vestingAttemptResponseSchema } from "./responses.ts";
import {
  checkpointVestedAt,
  linearVestedAt,
  vestingPreview,
  type VestingState,
} from "@interest-protocol/blast-util-sdk/vesting";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  isValidSuiAddress,
} from "@mysten/sui/utils";
import { z } from "zod";

/** `blast_fun_vesting` on mainnet: immutable, so its original and current id. */
export const VESTING_PACKAGE: string = mainnet.vesting.packageId;
export const VESTING_DEPLOYMENT = {
  packageId: VESTING_PACKAGE,
  originalPackageId: VESTING_PACKAGE,
};
export const U64_MAX = 18_446_744_073_709_551_615n;
const u64 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((value) => BigInt(value) <= U64_MAX);
const address = z
  .string()
  .refine(isValidSuiAddress)
  .transform((value) => normalizeSuiAddress(value))
  .refine((value) => BigInt(value) !== 0n);
const coinType = z
  .string()
  .min(8)
  .max(512)
  .transform((value, context) => {
    try {
      return normalizeStructTag(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Enter the full Sui coin type.",
      });
      return z.NEVER;
    }
  });
export const createVestingSchema = z
  .strictObject({
    action: z.literal("create"),
    coinType,
    total: u64.refine((value) => BigInt(value) > 0n),
    beneficiary: address,
    refundRecipient: address.nullable(),
    cancelCapRecipient: address.nullable(),
    schedule: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("linear"),
        start_ms: u64,
        cliff_ms: u64,
        period_ms: u64,
        periods: u64,
      }),
      z.strictObject({
        kind: z.literal("checkpoints"),
        checkpoints: z
          .array(z.strictObject({ timestamp_ms: u64, cumulative_amount: u64 }))
          .min(1)
          .max(256),
      }),
    ]),
  })
  .refine(
    (value) =>
      (value.refundRecipient === null) === (value.cancelCapRecipient === null),
  );
export const vestingIntentSchema = z.union([
  createVestingSchema,
  z.strictObject({
    action: z.enum(["claim", "cancel", "close"]),
    scheduleId: address,
  }),
]);
export type CreateVesting = z.infer<typeof createVestingSchema>;
export type VestingIntent = z.infer<typeof vestingIntentSchema>;
export type VestingTerms =
  | CreateVesting["schedule"]
  | { kind: "checkpoints"; checkpoints: null; checkpoint_count: string };

/** 1 ms is the chain clock's resolution; larger periods are historical stepped schedules. */
export function isContinuousLinear(terms: VestingTerms): boolean {
  return terms.kind === "linear" && terms.period_ms === "1";
}
export type PublicVesting = Readonly<z.infer<typeof publicVestingSchema>>;
export type VestingActivity = Readonly<{
  event_id: string;
  kind: string;
  timestamp_ms: string;
  digest: string;
  payload: Record<string, string>;
}>;
export type VestingDetail = Readonly<{
  now_ms: number;
  schedule: PublicVesting;
  events: readonly VestingActivity[];
}>;
export type VestingAttempt = Readonly<z.infer<typeof vestingAttemptResponseSchema>>;

export function vestingPath(id: string): string {
  return `/vesting/${address.parse(id.trim())}`;
}
export function scheduleOf(state: VestingState): VestingTerms {
  return state.kind === "linear"
    ? {
        kind: "linear",
        start_ms: String(state.schedule.startMs),
        cliff_ms: String(state.schedule.cliffMs),
        period_ms: String(state.schedule.periodMs),
        periods: String(state.schedule.periods),
      }
    : {
        kind: "checkpoints",
        checkpoints: state.checkpoints.map((point) => ({
          timestamp_ms: String(point.timestampMs),
          cumulative_amount: String(point.cumulativeAmount),
        })),
      };
}
export function vestingAmounts(schedule: PublicVesting, timestamp: bigint) {
  const total = BigInt(schedule.total);
  if (schedule.status !== "active")
    return {
      vested: BigInt(schedule.released),
      released: BigInt(schedule.released),
      releasable: 0n,
      unvested: 0n,
    };
  const terms = schedule.terms;
  if (terms.kind === "checkpoints" && terms.checkpoints === null) return null;
  const vested =
    terms.kind === "linear"
      ? linearVestedAt(
          total,
          {
            startMs: BigInt(terms.start_ms),
            cliffMs: BigInt(terms.cliff_ms),
            periodMs: BigInt(terms.period_ms),
            periods: BigInt(terms.periods),
          },
          timestamp,
        )
      : checkpointVestedAt(
          terms.checkpoints!.map((point) => ({
            timestampMs: BigInt(point.timestamp_ms),
            cumulativeAmount: BigInt(point.cumulative_amount),
          })),
          timestamp,
        );
  return vestingPreview(total, vested, BigInt(schedule.released));
}
/** Display preserves every atom. Unknown decimals are explicitly shown as atomic units. */
export function formatVestingAmount(
  value: bigint | string,
  decimals: number | null,
): string {
  const text = String(value);
  if (decimals === null) return `${text} atoms`;
  if (decimals === 0) return text;
  const padded = text.padStart(decimals + 1, "0");
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  return `${padded.slice(0, -decimals)}${fraction ? `.${fraction}` : ""}`;
}
export function parseVestingAmount(text: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text))
    throw new Error("Enter a positive amount without separators.");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals)
    throw new Error(`This coin supports ${decimals} decimal places.`);
  const atoms = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  if (atoms <= 0n || atoms > U64_MAX)
    throw new Error("Amount must fit a positive Sui u64 balance.");
  return String(atoms);
}
export function nextUnlock(terms: VestingTerms, now: bigint): bigint | null {
  if (terms.kind === "checkpoints")
    return (
      terms.checkpoints
        ?.map((point) => BigInt(point.timestamp_ms))
        .find((time) => time > now) ?? null
    );
  const start = BigInt(terms.start_ms),
    period = BigInt(terms.period_ms),
    count = BigInt(terms.periods),
    cliff = start + BigInt(terms.cliff_ms);
  const end = start + period * count;
  if (now >= end) return null;
  if (now < cliff && cliff >= start + period) return cliff;
  const next =
    now < start
      ? start + period
      : start + ((now - start) / period + 1n) * period;
  return next < cliff ? cliff : next;
}
