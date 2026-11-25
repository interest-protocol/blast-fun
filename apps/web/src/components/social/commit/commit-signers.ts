import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";

import { sponsoredWalletSigner } from "#web/lib/sui-signing.ts";
import type { SponsoredSigner } from "#web/components/social/sponsored-transaction.ts";

import type { CommitSigner } from "./commit-flow";

/** The Sui wallet kit (dApp Kit, Slush, the node client), loaded when a wallet session signs, not with the page. */
const loadWalletKit = () => import("#web/components/sign-in/sui-wallet-signer.ts");

/**
 * A wallet session's commit signer (Sui wallets, OA-16). It signs only, like the
 * withdrawal signer: a commit must know its digest before submission,
 * so that the intent can be registered there (T-024). The flow executes the
 * signed bytes on the fullnode itself. This is the wallet-pays arm, which
 * only a trade past the day's cap uses; `blastWalletSigner` puts it on
 * Blast's gas everywhere else.
 */
export function walletCommitSigner(address: string): CommitSigner {
  return {
    fee: "wallet",
    address: normalizeSuiAddress(address),
    async signTransaction(bytes: Uint8Array) {
      const { socialDAppKit, suiSigningAccount } = await loadWalletKit();
      const kit = socialDAppKit();
      const account = await suiSigningAccount(address);
      const signed = await kit.signTransaction({ transaction: toBase64(bytes), account });
      // dApp Kit answers the bytes it signed; the flow compares them with what
      // it built before anything is sent.
      return { bytes: signed.bytes, signature: signed.signature };
    },
  };
}

/** The digest-bearing bytes of a base64 transaction, for a caller that holds only the string. */
export function bytesOf(base64: string): Uint8Array {
  return fromBase64(base64);
}

/**
 * The Blast wallet's signer at a press, always on Blast's gas (owner ruling
 * 2026-11-20, reversing OA-17): Privy's embedded key, or a wallet session's
 * wallet signing the sponsor's exact bytes. Null while there is no address,
 * or the embedded signer is not ready for it.
 */
export function blastWalletSigner(
  wallet: Pick<SocialWallet, "address" | "signer"> | null,
  embedded: () => CommitSigner | null,
  own: (address: string) => CommitSigner = walletCommitSigner,
): SponsoredSigner | null {
  const address = wallet?.address ?? null;
  if (wallet === null || address === null) return null;
  if (wallet.signer === "privy") {
    const signer = embedded();
    return signer?.fee === "sponsored" && normalizeSuiAddress(signer.address) === normalizeSuiAddress(address) ? signer : null;
  }
  const signer = own(address);
  return signer.fee === "wallet" ? sponsoredWalletSigner(signer) : signer;
}
