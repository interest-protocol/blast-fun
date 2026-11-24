import { z } from "zod";
import { parseHttpsUrl } from "@blast/core/lib/https-url.ts";
import { SOCIAL_LIMITS, type SocialLimits } from "./limits.ts";

export const POST_KINDS = [
  "creator_thesis",
  "creator_update",
  "community_thesis",
] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const THESIS_STANCES = ["bullish", "bearish", "neutral"] as const;
export type ThesisStance = (typeof THESIS_STANCES)[number];

/**
 * The server's verification of a disclosed wallet, at one blast-infra holder
 * snapshot checkpoint: `verified_holder` (it holds the coin), `not_holder` (a
 * complete snapshot without it), `unavailable` (no complete answer in time),
 * `not_requested` (no wallet disclosed).
 */
export const VERIFICATIONS = [
  "verified_holder",
  "not_holder",
  "unavailable",
  "not_requested",
] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const VISIBILITIES = ["public", "hidden"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** The exact keys of a post write's `input`, and of its `disclosure`. */
export const POST_FIELDS = [
  "launchId",
  "kind",
  "stance",
  "body",
  "evidenceLinks",
  "disclosure",
  "revisionOf",
] as const;
export const DISCLOSURE_FIELDS = ["text", "walletAddress"] as const;

export type DisclosureInput = Readonly<{
  /** The author's own words about their position, inert text; null when none. */
  text: string | null;
  /** A wallet the author discloses and asks the server to verify; it must be the writer's own. */
  walletAddress: string | null;
}>;

export type PostInput = Readonly<{
  launchId: string;
  kind: PostKind;
  /** Null only for a creator update. */
  stance: ThesisStance | null;
  body: string;
  evidenceLinks: readonly string[];
  disclosure: DisclosureInput;
  /** The record this one revises: the post's current record. */
  revisionOf: string | null;
}>;

export const UNSAFE_TEXT =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

export function parseInertText(value: unknown, maximum: number): string {
  const parsed = z.string().refine((text) => text.isWellFormed()).safeParse(value);
  if (!parsed.success) throw new TypeError("Expected text.");
  const text = parsed.data.replace(/\r\n?/g, "\n").normalize("NFC").trim();
  if (!z.string().refine((value) => [...value].length > 0 && [...value].length <= maximum).safeParse(text).success) throw new TypeError("Text is empty or too long.");
  if (!z.string().refine((value) => !UNSAFE_TEXT.test(value)).safeParse(text).success) throw new TypeError("Text holds a control or override character.");
  return text;
}

/** Distinct https links without credentials, in normalized form, within the limits. */
export function parseEvidenceLinks(value: unknown, limits: SocialLimits = SOCIAL_LIMITS): string[] {
  const parsed = z.array(z.unknown()).max(limits.evidenceLinks).safeParse(value);
  if (!parsed.success) throw new TypeError("Too many links.");
  return [...new Set(parsed.data.map((url) => parseHttpsUrl(url, limits.evidenceLinkLength)))];
}

export type Disclosure = Readonly<{
  text: string | null;
  walletAddress: string | null;
  verification: Verification;
  /** The holder snapshot's checkpoint (a decimal string) and time; null unless verified or not a holder. */
  observedCheckpoint: string | null;
  observedAt: string | null;
}>;

export type PublicPost = Readonly<{
  id: string;
  thesisId: string;
  revisionOf: string | null;
  launchId: string;
  kind: PostKind;
  stance: ThesisStance | null;
  authorIdentityId: string;
  body: string;
  evidenceLinks: readonly string[];
  disclosure: Disclosure;
  authorLabels: readonly string[];
  provenance: Readonly<{
    network: string;
    deployment: string;
    checkpoint: number;
  }>;
  postedAt: string;
  createdAt: string;
  moderationState: "public";
}>;
