import { createHash } from "node:crypto";

import type {
  IssueWalletChallengeRequest,
  WalletChallengeContext,
} from "@blast/server/modules/mission-control/wallet-challenges/contracts.ts";

export const WALLET_CHALLENGE_TTL_MS = 5 * 60 * 1_000;

export interface WalletChallengeMessageBinding
  extends IssueWalletChallengeRequest {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

function contextLine(context: WalletChallengeContext): string {
  if (context.kind === "attempt") return `Attempt: ${context.id}`;
  if (context.kind === "recovery") return `Recovery context: ${context.id}`;
  return `Blast account: ${context.id}`;
}

function authorizationLines(
  authorization: IssueWalletChallengeRequest["authorization"],
): string[] {
  if (!authorization) return [];
  return [
    "",
    "Purpose: Create my BLAST.FUN Season Zero profile",
    `Callsign: @${authorization.callsign}`,
    `Fleet: ${authorization.fleet}`,
    `Profile authorization hash: ${authorization.profileHash}`,
    `Disclosure version: ${authorization.disclosureVersion}`,
    `Terms version: ${authorization.termsVersion} (${authorization.termsHash})`,
    `Privacy version: ${authorization.privacyVersion} (${authorization.privacyHash})`,
    `Accepted at: ${authorization.acceptedAt}`,
  ];
}

export function buildWalletChallengeMessage(
  binding: WalletChallengeMessageBinding,
): string {
  const purpose = binding.action === "link_wallet"
    ? ["", "Purpose: Link this wallet to my BLAST.FUN account"]
    : binding.action === "sign_in"
      ? ["", "Purpose: Sign in to BLAST.FUN with this wallet"]
      : [];
  return [
    "BLAST.FUN wallet verification",
    "",
    `Action: ${binding.action}`,
    `Address: ${binding.address}`,
    `Origin: ${binding.origin}`,
    contextLine(binding.context),
    ...purpose,
    ...authorizationLines(binding.authorization),
    `Nonce: ${binding.nonce}`,
    `Issued at: ${binding.issuedAt}`,
    `Expires at: ${binding.expiresAt}`,
  ].join("\n");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function extractWalletChallengeNonce(message: string): string | null {
  const match = message.match(/(?:^|\n)Nonce: ([A-Za-z0-9_-]{43})(?:\n|$)/);
  return match?.[1] ?? null;
}
