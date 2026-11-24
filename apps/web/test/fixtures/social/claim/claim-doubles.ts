import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { ClaimSigner } from "#web/components/social/claim/claim-flow.ts";
import type { TransactionSigner } from "#web/components/social/sponsored-transaction.ts";

/**
 * The claim flow's test doubles (R3-63), for tests only and never imported by
 * application code: the full transaction bytes a sponsor or a wallet builds
 * around a claim's kind, and signers that sign, decline or rebuild. No key
 * exists here: a "signature" is a fixed placeholder the stubbed executor
 * accepts.
 */

export const FAKE_SPONSOR = normalizeSuiAddress(`0x${"5b".repeat(32)}`);
export const FAKE_SIGNATURE = "AFAKE-SIGNATURE-FOR-TESTS";

/** Full `TransactionData` V1 bytes: the kind unchanged, from `sender`, gas owned by `owner`. */
export function transactionBytesFor(kind: Uint8Array, sender: string, owner: string = sender): Uint8Array {
  return bcs.TransactionData.serialize({
    V1: {
      kind: bcs.TransactionKind.parse(kind),
      sender: normalizeSuiAddress(sender),
      gasData: { payment: [], owner: normalizeSuiAddress(owner), price: 1_000n, budget: 5_000_000n },
      expiration: { None: true },
    },
  }).toBytes();
}

/** An embedded wallet's signer: signs whatever bytes it is given, or throws `error`. */
export function sponsoredSigner(address: string, options: Readonly<{ error?: Error; signed?: Uint8Array[] }> = {}): ClaimSigner {
  return {
    fee: "sponsored",
    address: normalizeSuiAddress(address),
    async signTransaction(bytes) {
      options.signed?.push(bytes);
      if (options.error) throw options.error;
      return FAKE_SIGNATURE;
    },
  };
}

/**
 * A wallet session's own signer: signs and answers the bytes it signed
 * (`rebuild` answers others), or throws `error`. Flows take it through
 * `sponsoredWalletSigner`.
 */
export function walletSigner(
  address: string,
  options: Readonly<{ error?: Error; rebuild?: boolean; signed?: Uint8Array[] }> = {},
): Extract<TransactionSigner, { fee: "wallet" }> {
  return {
    fee: "wallet",
    address: normalizeSuiAddress(address),
    async signTransaction(bytes) {
      options.signed?.push(bytes);
      if (options.error) throw options.error;
      const answered = options.rebuild ? Uint8Array.from([...bytes, 0]) : bytes;
      return { bytes: Buffer.from(answered).toString("base64"), signature: FAKE_SIGNATURE };
    },
  };
}
