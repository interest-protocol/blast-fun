import { isSocialCallsign } from "@blast/core/web/contracts/accounts.ts";
import type { SocialCallsignUnavailableReason } from "@blast/core/web/contracts/accounts.ts";

/** The callsign field's limit; typing is cut here. */
export const CALLSIGN_MAX_LENGTH = 20;

/** How long typing must pause before the callsign is checked. */
export const CALLSIGN_CHECK_DELAY_MS = 420;

/** The official account's callsign, also used by search. */
export const OFFICIAL_CALLSIGN = "blast";

/** As the visitor types: lowercased, only letters, digits and underscores, at most 20. */
export function typedCallsign(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, CALLSIGN_MAX_LENGTH);
}

/** The design's suggestion for a taken callsign: its first 15 characters and `_sui`. */
export function suggestedCallsign(callsign: string): string {
  return `${callsign.slice(0, 15)}_sui`;
}

export type CallsignCheck =
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "invalid" }>
  | Readonly<{ status: "checking"; callsign: string }>
  | Readonly<{ status: "available"; callsign: string }>
  /** `suggestion` was checked and is free; null when it is not. */
  | Readonly<{ status: "taken"; callsign: string; suggestion: string | null }>
  | Readonly<{ status: "reserved"; callsign: string }>
  | Readonly<{ status: "blocked"; callsign: string }>
  /** The check itself failed (offline, rate limited). */
  | Readonly<{ status: "unchecked"; callsign: string }>;

/** What the field says before any server answer: empty, a bad format, or checking. */
export function localCallsignCheck(callsign: string): CallsignCheck {
  if (!callsign) return { status: "empty" };
  if (!isSocialCallsign(callsign)) return { status: "invalid" };
  return { status: "checking", callsign };
}

/** A server answer as the field's state (`taken` waits for its suggestion's check). */
export function checkFromReason(
  callsign: string,
  reason: SocialCallsignUnavailableReason | null,
  suggestion: string | null = null,
): CallsignCheck {
  switch (reason) {
    case null:
      return { status: "available", callsign };
    case "invalid":
      return { status: "invalid" };
    case "taken":
      return { status: "taken", callsign, suggestion };
    case "reserved":
      return { status: "reserved", callsign };
    case "blocked":
      return { status: "blocked", callsign };
  }
}

export type CallsignMessage = Readonly<{ text: string; tone: "muted" | "ok" | "bad" }>;

/** The line under the field (the design's copy; `blocked` and a failed check are not in the design). */
export function callsignMessage(check: CallsignCheck): CallsignMessage {
  switch (check.status) {
    case "empty":
      return { text: "3 to 20 letters, numbers or underscores.", tone: "muted" };
    case "invalid":
      return { text: "Use 3 to 20 characters. Start and end with a letter or number.", tone: "bad" };
    case "checking":
      return { text: "Checking…", tone: "muted" };
    case "available":
      return { text: `@${check.callsign} is available`, tone: "ok" };
    case "taken":
      return {
        text: check.suggestion ? `@${check.callsign} is taken. Try @${check.suggestion}.` : `@${check.callsign} is taken.`,
        tone: "bad",
      };
    case "reserved":
      return { text: `@${check.callsign} is reserved.`, tone: "bad" };
    case "blocked":
      return { text: `@${check.callsign} is not available.`, tone: "bad" };
    case "unchecked":
      return { text: `@${check.callsign} could not be checked. Try again in a moment.`, tone: "bad" };
  }
}
