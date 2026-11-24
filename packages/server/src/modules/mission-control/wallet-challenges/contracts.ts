import { z } from "zod";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { isLoopbackHostname } from "@blast/core/lib/loopback.ts";

export const WALLET_CHALLENGE_ACTIONS = [
  "onboarding",
  "restore_crew_access",
  "link_wallet",
  // Social feed UI-08: signing in to the social feed with a Sui wallet (Slush).
  "sign_in",
] as const;

export type WalletChallengeAction =
  (typeof WALLET_CHALLENGE_ACTIONS)[number];

export type WalletChallengeContext =
  | { kind: "attempt"; id: string }
  | { kind: "recovery"; id: string }
  | { kind: "account"; id: string };

export interface WalletChallengeAuthorization {
  acceptedAt: string;
  callsign: string;
  disclosureVersion: string;
  fleet: string;
  kind: "season-zero-profile";
  privacyHash: string;
  privacyVersion: string;
  profileHash: string;
  termsHash: string;
  termsVersion: string;
}

export interface IssueWalletChallengeRequest {
  action: WalletChallengeAction;
  address: string;
  origin: string;
  context: WalletChallengeContext;
  authorization?: WalletChallengeAuthorization;
}

export interface IssuedWalletChallenge extends IssueWalletChallengeRequest {
  challengeId: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
}

export interface VerifyWalletChallengeRequest
  extends IssueWalletChallengeRequest {
  challengeId: string;
  message: string;
  signature: string;
}

export interface WalletControlProof extends IssueWalletChallengeRequest {
  proofType: "sui_personal_message";
  challengeId: string;
  verifiedAt: string;
}

const CONTEXT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const recordSchema = z.record(z.string(), z.unknown());
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const suiAddressSchema = z.string().min(1).max(66)
  .regex(/^(?:0x)?[0-9a-fA-F]{1,64}$/)
  .transform((value) => normalizeSuiAddress(value)).refine(isValidSuiAddress);
const actionSchema = z.enum(WALLET_CHALLENGE_ACTIONS);
const contextKindSchema = z.enum(["attempt", "recovery", "account"]);

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Expected an object.");
  return parsed.data;
}

function asNonEmptyString(value: unknown, maximum: number): string {
  const parsed = z.string().min(1).max(maximum).safeParse(value);
  if (!parsed.success) throw new TypeError("Expected a bounded non-empty string.");
  return parsed.data;
}

function asHash(value: unknown): string {
  const parsed = hashSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Expected a SHA-256 hash.");
  return parsed.data;
}

export function canonicalSuiAddress(value: unknown): string {
  const address = asNonEmptyString(value, 66);
  const parsed = suiAddressSchema.safeParse(address);
  if (!parsed.success) throw new TypeError("Invalid Sui address.");
  return parsed.data;
}

export function canonicalOrigin(value: unknown): string {
  const origin = asNonEmptyString(value, 255);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("Invalid origin.");
  }

  if (
    parsed.origin !== origin ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)))
  ) {
    throw new TypeError("Origin must be canonical and secure.");
  }
  return parsed.origin;
}

function parseAction(value: unknown): WalletChallengeAction {
  const parsed = actionSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid wallet challenge action.");
  return parsed.data;
}

function parseContext(value: unknown): WalletChallengeContext {
  const context = asRecord(value);
  const id = asNonEmptyString(context.id, 128);
  const parsedId = z.string().regex(CONTEXT_ID).safeParse(id);
  const kind = contextKindSchema.safeParse(context.kind);
  if (!parsedId.success || !kind.success) throw new TypeError("Invalid wallet challenge context.");
  return { kind: kind.data, id };
}

function parseAuthorization(
  value: unknown,
): WalletChallengeAuthorization | undefined {
  if (value === undefined) return undefined;
  const authorization = asRecord(value);
  if (
    authorization.kind !== "season-zero-profile" ||
    !hashSchema.safeParse(authorization.profileHash).success
  ) {
    throw new TypeError("Invalid wallet authorization.");
  }
  const acceptedAt = asNonEmptyString(authorization.acceptedAt, 64);
  if (!z.string().refine((text) => Number.isFinite(Date.parse(text))).safeParse(acceptedAt).success) {
    throw new TypeError("Invalid wallet authorization.");
  }
  return {
    acceptedAt: new Date(acceptedAt).toISOString(),
    callsign: asNonEmptyString(authorization.callsign, 20),
    disclosureVersion: asNonEmptyString(
      authorization.disclosureVersion,
      100,
    ),
    fleet: asNonEmptyString(authorization.fleet, 32),
    kind: "season-zero-profile",
    privacyHash: asHash(authorization.privacyHash),
    privacyVersion: asNonEmptyString(authorization.privacyVersion, 32),
    profileHash: asHash(authorization.profileHash),
    termsHash: asHash(authorization.termsHash),
    termsVersion: asNonEmptyString(authorization.termsVersion, 32),
  };
}

export function parseIssueWalletChallengeRequest(
  value: unknown,
): IssueWalletChallengeRequest {
  const request = asRecord(value);
  const action = parseAction(request.action);
  const context = parseContext(request.context);
  if (
    (action === "onboarding" && context.kind !== "attempt") ||
    (action === "restore_crew_access" && context.kind !== "recovery") ||
    (action === "link_wallet" && context.kind !== "account") ||
    (action === "sign_in" && context.kind !== "attempt")
  ) {
    throw new TypeError("Action and context do not match.");
  }
  return {
    action,
    address: canonicalSuiAddress(request.address),
    origin: canonicalOrigin(request.origin),
    context,
    authorization: parseAuthorization(request.authorization),
  };
}

export function parseVerifyWalletChallengeRequest(
  value: unknown,
): VerifyWalletChallengeRequest {
  const request = asRecord(value);
  const binding = parseIssueWalletChallengeRequest(request);
  const challengeId = asNonEmptyString(request.challengeId, 36);
  if (!z.string().regex(UUID).safeParse(challengeId).success) {
    throw new TypeError("Invalid challenge identifier.");
  }
  return {
    ...binding,
    challengeId: challengeId.toLowerCase(),
    message: asNonEmptyString(request.message, 2_048),
    signature: asNonEmptyString(request.signature, 8_192),
  };
}
