import { bcs } from "@mysten/sui/bcs";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import type { TransactionSigner } from "#web/components/social/sponsored-transaction.ts";

/** Decode the sponsor's transaction only when it is exactly `kind` from `sender`. */
export function readSponsoredBytes(encoded: string, kind: Uint8Array, sender: string): Uint8Array | null {
  try {
    const bytes = fromBase64(encoded);
    const data = bcs.TransactionData.parse(bytes).V1;
    if (!data) return null;
    const signedKind = bcs.TransactionKind.serialize(data.kind).toBytes();
    return normalizeSuiAddress(data.sender) === normalizeSuiAddress(sender) && toBase64(signedKind) === toBase64(kind) ? bytes : null;
  } catch {
    return null;
  }
}

const REJECTION = /\b(reject(ed|ion)?|denied|declined|cancell?ed|closed)\b/i;
export function isSignatureRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === 4001 || REJECTION.test(error.message);
}

/** A wallet answered other bytes than the ones it was asked to sign: nothing it signed may go out. */
export class WalletChangedBytes extends Error {
  constructor() {
    super("The wallet signed a different transaction from the one Blast built.");
    this.name = "WalletChangedBytes";
  }
}

/**
 * A wallet session's signer on Blast's gas (owner ruling 2026-11-20): the
 * wallet signs exactly the sponsor's bytes. A wallet answers the bytes it
 * signed; when they differ (it rebuilt them, or put in its own gas) this
 * throws `WalletChangedBytes`, which `signExactly` reads as a mismatch, so
 * nothing is sent.
 */
export function sponsoredWalletSigner(
  wallet: Extract<TransactionSigner, { fee: "wallet" }>,
): Extract<TransactionSigner, { fee: "sponsored" }> {
  return {
    fee: "sponsored",
    address: wallet.address,
    async signTransaction(bytes) {
      const signed = await wallet.signTransaction(bytes);
      if (signed.bytes !== toBase64(bytes)) throw new WalletChangedBytes();
      return signed.signature;
    },
  };
}
