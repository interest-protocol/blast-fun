import { referralCallsign } from "./contracts.ts";
import type { ReferralInviter } from "./share.ts";

export const REFERRAL_CONTEXT_MAX_BYTES = 16 * 1024;
const VERSION = "blast.referral-inviter.v1";

function publicInviter(value: unknown, callsign: string): value is ReferralInviter | null {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") === "avatarUrl,callsign,crew,title"
    && row.callsign === callsign && referralCallsign(row.callsign) === callsign
    && (row.crew === null || Number.isSafeInteger(row.crew))
    && (row.title === null || typeof row.title === "string")
    && (row.avatarUrl === null || typeof row.avatarUrl === "string");
}

export function decodeReferralContext(text: string, callsign: string): ReferralInviter | null {
  if (new TextEncoder().encode(text).byteLength > REFERRAL_CONTEXT_MAX_BYTES) throw new Error("Referral context unavailable");
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Referral context unavailable");
  const row = data as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "inviter,version" || row.version !== VERSION || !publicInviter(row.inviter, callsign)) {
    throw new Error("Referral context unavailable");
  }
  return row.inviter;
}

export function encodeReferralContext(inviter: ReferralInviter | null, callsign: string): string {
  const text = JSON.stringify({ version: VERSION, inviter });
  decodeReferralContext(text, callsign);
  return text;
}
