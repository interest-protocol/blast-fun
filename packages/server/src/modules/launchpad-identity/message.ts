import { createHash } from "node:crypto";

import type { LaunchpadProofAction } from "@blast/server/modules/launchpad-identity/contracts.ts";

/** Everything a launchpad Wallet Proof is bound to. */
export interface LaunchpadProofBinding {
  action: LaunchpadProofAction;
  address: string;
  origin: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

const NONCE = /^[A-Za-z0-9_-]{43}$/;

export function isProofNonce(value: string): boolean {
  return NONCE.test(value);
}

/** The exact personal message the wallet signs. It is never a transaction. */
export function buildLaunchpadProofMessage(binding: LaunchpadProofBinding): string {
  return [
    "BLAST.FUN launchpad wallet proof",
    "",
    "Sign to prove you control this wallet. This is not a transaction and costs nothing.",
    "",
    `Action: ${binding.action}`,
    `Address: ${binding.address}`,
    `Origin: ${binding.origin}`,
    `Nonce: ${binding.nonce}`,
    `Issued at: ${binding.issuedAt}`,
    `Expires at: ${binding.expiresAt}`,
  ].join("\n");
}

export function extractProofNonce(message: string): string | null {
  return message.match(/(?:^|\n)Nonce: ([A-Za-z0-9_-]{43})(?:\n|$)/)?.[1] ?? null;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
