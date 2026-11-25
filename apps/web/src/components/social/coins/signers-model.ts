

import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import type { TransactionSigner } from "#web/components/social/sponsored-transaction.ts";

/** The Sui wallet kit (dApp Kit, Slush, the node client), loaded when a wallet session signs, not with the page. */
const loadWalletKit = () => import("#web/components/sign-in/sui-wallet-signer.ts");

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
      const { socialDAppKit, suiSigningAccount } = await loadWalletKit();
      const kit = socialDAppKit();
      const account = await suiSigningAccount(address);
      const signed = await kit.signTransaction({ transaction: toBase64(bytes), account });
      return { bytes: signed.bytes, signature: signed.signature };
    },
  };
}
