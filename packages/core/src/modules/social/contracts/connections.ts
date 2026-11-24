import { z } from "zod";
import { socialCallsignSchema, socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";

export type ConnectionTab = "followers" | "following";
export type ConnectionAccount = Readonly<{
  callsign: string;
  display_name: string | null;
  avatar_url: string | null;
  verified: boolean;
  private: boolean;
}>;
export type SocialConnectionCounts = Readonly<{
  /** Private actors are never named or counted, including on the owner’s profile. */
  followers: number;
  /** Owners see everyone they follow; other viewers see public accounts only. */
  following: number;
}>;
export type SocialConnections = Readonly<{
  accounts: readonly ConnectionAccount[];
  next_cursor: string | null;
}>;

/** No tab returns counts; a tab returns a page. Optional auth, primary reads, private/no-store.
 * Private profiles are owner-only. x-blast-public-view: 1 requests public visibility even with a session cookie. */
export function socialConnectionsPath(callsign: string): string {
  return `/api/social/profiles/${encodeURIComponent(callsign)}/connections`;
}

export function connectionsPagePath(callsign: string, tab: ConnectionTab): string {
  return `/@${encodeURIComponent(callsign)}/${tab}`;
}

export const socialConnectionCountsSchema = z.object({
  followers: socialCountSchema,
  following: socialCountSchema,
});

export const socialConnectionsSchema = z.object({
  accounts: z.array(z.object({
    callsign: socialCallsignSchema,
    display_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    verified: z.boolean(),
    private: z.boolean(),
  })).max(50),
  next_cursor: z.string().nullable(),
});

export function isSocialConnectionCounts(value: unknown): value is SocialConnectionCounts {
  return socialConnectionCountsSchema.safeParse(value).success;
}

export function isSocialConnections(value: unknown): value is SocialConnections {
  return socialConnectionsSchema.safeParse(value).success;
}
