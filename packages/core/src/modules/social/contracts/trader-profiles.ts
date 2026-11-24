import { z } from "zod";
import { isSocialCallsign } from "./accounts.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export const TRADER_PROFILES_PATH = "/api/social/home/trader-profiles";
export const RECENT_TRADES_LIMIT = 4;

const trader = z.object({
  address: z.string().regex(SUI_OBJECT_ID_PATTERN),
  timestampMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
const request = z.array(trader).min(1).max(RECENT_TRADES_LIMIT);
const profile = z.object({ callsign: z.string().refine(isSocialCallsign), avatarUrl: z.string().nullable() }).strict();
export const traderProfilesSchema = z.record(z.string(), profile.nullable());
export type TraderProfileRequest = z.infer<typeof trader>;
export type TraderProfile = z.infer<typeof profile>;
export type TraderProfiles = z.infer<typeof traderProfilesSchema>;

export const traderProfileKey = ({ address, timestampMs }: TraderProfileRequest) => `${address}:${timestampMs}`;

export function traderProfilesPath(traders: readonly TraderProfileRequest[]): string {
  return `${TRADER_PROFILES_PATH}?${new URLSearchParams({ traders: JSON.stringify(traders) })}`;
}

export function parseTraderProfilesRequest(url: URL, nowMs: number): readonly TraderProfileRequest[] | null {
  const values = url.searchParams.getAll("traders");
  if (values.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "traders")) return null;
  try {
    const parsed = request.safeParse(JSON.parse(values[0]!));
    if (!parsed.success || parsed.data.some(({ timestampMs }) => timestampMs > nowMs)) return null;
    return [...new Map(parsed.data.map((row) => [traderProfileKey(row), row])).values()];
  } catch {
    return null;
  }
}
