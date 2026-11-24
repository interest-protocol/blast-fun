import { z } from "zod";
import {
  socialCallsignSchema,
  socialCountSchema,
  socialUuidSchema,
} from "../contracts/primitives.ts";

export const REFERRALS_PATH = "/api/social/me/referrals";
export const REFERRAL_INVITEES_PATH = `${REFERRALS_PATH}/invitees`;
export const REFERRAL_PAGE_SIZE = 50;
export const REFERRAL_COOKIE = "__Host-blast_referral";
export const REFERRAL_MAX_AGE = 30 * 24 * 60 * 60;

const atomicTotal = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const referralAssetSchema = z.object({
  coin_type: z.string(),
  symbol: z.string().nullable(),
  decimals: z.number().int().min(0).max(255).nullable(),
  volume_atoms: atomicTotal,
  revenue_atoms: atomicTotal,
  earnings_atoms: atomicTotal,
});
export const referralAccountingSchema = z.object({
  assets: z.array(referralAssetSchema),
  share_bps: z.literal(6000),
  as_of_ms: z.number().int().nonnegative().nullable(),
  pending_events: socialCountSchema,
});
export type ReferralAsset = z.infer<typeof referralAssetSchema>;
export type ReferralAccounting = z.infer<typeof referralAccountingSchema>;

export type ReferralSummary = Readonly<{
  invited: number;
  volume_usd: string;
  unvalued_trades: number;
  referral_code?: string;
  accounting?: ReferralAccounting;
}>;

export function referralCallsign(value: unknown): string | null {
  const parsed = z
    .string()
    .regex(/^[a-z0-9_]{3,20}$/)
    .safeParse(typeof value === "string" ? value.toLowerCase() : value);
  return parsed.success ? parsed.data : null;
}

export function referralPath(callsign: string): string {
  const valid = referralCallsign(callsign);
  if (!valid) throw new TypeError("Invalid referral callsign.");
  return `/?ref=${encodeURIComponent(valid)}`;
}

export function requestReferral(request: Request): string | null {
  const cookie = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REFERRAL_COOKIE}=`));
  return referralCallsign(cookie?.slice(REFERRAL_COOKIE.length + 1));
}

export const referralSummarySchema = z.object({
  invited: socialCountSchema,
  volume_usd: z.string().regex(/^\d+\.\d{2}$/),
  unvalued_trades: socialCountSchema,
  referral_code: z
    .string()
    .regex(/^[a-z0-9_]{3,20}$/)
    .optional(),
  accounting: referralAccountingSchema.optional(),
});

export function isReferralSummary(value: unknown): value is ReferralSummary {
  return referralSummarySchema.safeParse(value).success;
}

export type ReferralInvitee = Readonly<{
  id: string;
  callsign: string | null;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  /** When the invitee joined through the owner (ms): the "Joined Oct 24" line. The read always sends it. */
  joined_at_ms?: number;
  accounting?: ReferralAccounting;
}>;

export type ReferralInvitees = Readonly<{
  invitees: readonly ReferralInvitee[];
  next_cursor: string | null;
}>;

export function isReferralCursor(value: unknown): value is string {
  return socialUuidSchema.safeParse(value).success;
}

export const referralInviteesSchema = z.object({
  invitees: z
    .array(
      z.object({
        id: socialUuidSchema,
        callsign: socialCallsignSchema.nullable(),
        display_name: z.string().nullable(),
        avatar_url: z.string().nullable(),
        x_handle: z.string().nullable(),
        joined_at_ms: z.number().int().nonnegative().optional(),
        accounting: referralAccountingSchema.optional(),
      }),
    )
    .max(REFERRAL_PAGE_SIZE),
  next_cursor: socialUuidSchema.nullable(),
});

export function isReferralInvitees(value: unknown): value is ReferralInvitees {
  return referralInviteesSchema.safeParse(value).success;
}
