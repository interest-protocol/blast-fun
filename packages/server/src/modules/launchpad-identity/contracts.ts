import { z } from "zod";
import {
  canonicalOrigin,
  canonicalSuiAddress,
} from "@blast/server/modules/mission-control/wallet-challenges/contracts.ts";

export { canonicalOrigin, canonicalSuiAddress };

/**
 * The launchpad writes a Wallet Proof may authorize, one proof per write.
 * A module that adds a protected write adds its action here; the database
 * accepts any lowercase name, so no migration is needed.
 */
export const LAUNCHPAD_PROOF_ACTIONS = ["social_post", "launch_metadata", "launch_asset"] as const;

export type LaunchpadProofAction = (typeof LAUNCHPAD_PROOF_ACTIONS)[number];

/** How long an issued challenge can be signed and used. */
export const LAUNCHPAD_WALLET_PROOF_TTL_MS = 5 * 60 * 1_000;

export const WALLET_PROOF_MESSAGE_MAX_LENGTH = 2_048;
export const WALLET_PROOF_SIGNATURE_MAX_LENGTH = 8_192;

/** A signed launchpad challenge, as a protected write receives it. */
export interface LaunchpadWalletProof {
  address: string;
  challengeId: string;
  message: string;
  signature: string;
}

/**
 * Who performed a protected write: the only attribution a module may store.
 * A Privy actor is a keyed hash of the Privy DID, never the DID itself; its
 * wallet is the user's embedded Sui wallet when one exists.
 */
export type LaunchpadActor = Readonly<
  | { method: "privy"; subjectKey: string; walletAddress: string | null }
  | { method: "wallet_proof"; walletAddress: string }
>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return z.record(z.string(), z.unknown().nonoptional()).safeParse(value).success;
}

/** An object with exactly these keys, no more and no fewer. */
export function hasExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  const shape = Object.fromEntries(keys.map((key) => [key, z.unknown().nonoptional()]));
  return z.strictObject(shape).safeParse(value).success;
}

function boundedString(value: unknown, maximum: number): string {
  const parsed = z.string().min(1).max(maximum).safeParse(value);
  if (!parsed.success) throw new TypeError("Expected a bounded non-empty string.");
  return parsed.data;
}

export function parseLaunchpadProofAction(value: unknown): LaunchpadProofAction {
  const parsed = z.enum(LAUNCHPAD_PROOF_ACTIONS).safeParse(value);
  if (!parsed.success) throw new TypeError("Unknown launchpad proof action.");
  return parsed.data;
}

export function parseChallengeId(value: unknown): string {
  const id = boundedString(value, 36);
  if (!z.string().regex(UUID).safeParse(id).success) throw new TypeError("Invalid challenge identifier.");
  return id.toLowerCase();
}

export function parseWalletProof(value: unknown): LaunchpadWalletProof {
  if (!hasExactKeys(value, ["address", "challengeId", "message", "signature"])) {
    throw new TypeError("A wallet proof has exactly four fields.");
  }
  return {
    address: canonicalSuiAddress(value.address),
    challengeId: parseChallengeId(value.challengeId),
    message: boundedString(value.message, WALLET_PROOF_MESSAGE_MAX_LENGTH),
    signature: boundedString(value.signature, WALLET_PROOF_SIGNATURE_MAX_LENGTH),
  };
}
