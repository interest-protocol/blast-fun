import { z } from "zod";

import { referralCallsign, referralPath } from "@blast/core/modules/social/referrals/contracts.ts";

export const PNL_CARD_SHARE_PATH = "/api/social/me/pnl/card";
export const PNL_CARD_SHARE_MAX_BYTES = 4 * 1_024 * 1_024;
export const PNL_CARD_SHARE_ID = /^[a-f0-9]{64}$/;

export type PnlCardPage = Readonly<{ id: string; exists: boolean }>;

export function parsePnlCardPage(
  text: string,
  expectedId: string,
): PnlCardPage {
  if (new TextEncoder().encode(text).byteLength > 16 * 1024)
    throw new Error("PnL card page unavailable");
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("PnL card page unavailable");
  const page = value as Record<string, unknown>;
  if (
    Object.keys(page).sort().join(",") !== "exists,id" ||
    page.id !== expectedId ||
    typeof page.exists !== "boolean" ||
    (page.exists && !PNL_CARD_SHARE_ID.test(expectedId))
  ) {
    throw new Error("PnL card page unavailable");
  }
  return { id: expectedId, exists: page.exists };
}

export function pnlCardSharePath(id: string, callsign?: string): string {
  return `/card/pnl/${id}${callsign ? referralPath(callsign).slice(1) : ""}`;
}

export const pnlCardShareSchema = z.object({
  path: z.string().regex(/^\/card\/pnl\/[a-f0-9]{64}(?:\?ref=([a-z0-9_]+))?$/).refine((path) => {
    const callsign = path.split("?ref=")[1];
    return callsign === undefined || referralCallsign(callsign) === callsign;
  }),
});

export function isPnlCardShare(value: unknown): value is { path: string } {
  return pnlCardShareSchema.safeParse(value).success;
}
