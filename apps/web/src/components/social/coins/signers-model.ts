

import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import { suiSigningAccount, socialDAppKit } from "#web/components/sign-in/sui-wallet-signer.ts";
import type { TransactionSigner } from "#web/components/social/sponsored-transaction.ts";

/**
 * A wallet session's signer (Sui wallets, OA-16): the social pages' dApp Kit
 * connects the wallet used at sign-in, resolves the
 * session's wallet among its authorized accounts, then signs prebuilt bytes.
 * `blastWalletSigner` puts it on Blast's gas (`sponsoredWalletSigner`), which
 * refuses any bytes the wallet changed.
 */
export function walletSessionSigner(address: string): Extract<TransactionSigner, { fee: "wallet" }> {
  return {
    fee: "wallet",
    address: normalizeSuiAddress(address),
    async signTransaction(bytes: Uint8Array) {
      const kit = socialDAppKit();
      const account = await suiSigningAccount(address);
      const signed = await kit.signTransaction({ transaction: toBase64(bytes), account });
      return { bytes: signed.bytes, signature: signed.signature };
    },
  };
}
