import { z } from "zod";

export const MEMBER_SESSION_SCOPE = "member" as const;
export type MemberSessionScope = typeof MEMBER_SESSION_SCOPE;

export type MemberAuthorization = Readonly<{
  profileId: string;
  scope: MemberSessionScope;
}>;

export type IssueMemberSessionInput = Readonly<{
  profileId: string;
  scope?: MemberSessionScope;
}>;

export type SessionCookieSink = (setCookieHeader: string) => void;

export type MemberSessionPolicy = Readonly<{
  absoluteTtlMs: number;
  idleTtlMs: number;
}>;

export const DEFAULT_MEMBER_SESSION_POLICY: MemberSessionPolicy = Object.freeze({
  absoluteTtlMs: 30 * 24 * 60 * 60 * 1_000,
  idleTtlMs: 7 * 24 * 60 * 60 * 1_000,
});

const MAX_COOKIE_TTL_MS = 31 * 24 * 60 * 60 * 1_000;

/** A session never outlives its cookie, and never idles past its absolute end. */
export const memberSessionPolicySchema = z
  .object({
    idleTtlMs: z.number().int().min(1_000),
    absoluteTtlMs: z.number().int().max(MAX_COOKIE_TTL_MS),
  })
  .refine((policy) => policy.absoluteTtlMs >= policy.idleTtlMs);

/**
 * How often an active session records its activity. Every authenticated
 * request reads the session; only a request that finds `last_seen_at` at least
 * this old writes, extending `idle_expires_at`. A page load's parallel requests
 * therefore cost one write per interval instead of one each, and idle expiry
 * can arrive up to this much early, which is immaterial against the 7-day idle
 * TTL. Policies whose idle TTL is shorter than twice this use half the idle TTL.
 */
export const MEMBER_SESSION_REFRESH_INTERVAL_MS = 10 * 60 * 1_000;
