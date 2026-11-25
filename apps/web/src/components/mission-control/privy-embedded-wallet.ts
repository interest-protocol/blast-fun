import { normalizeSuiAddress } from "@mysten/sui/utils";

/**
 * The signed-in user's Privy embedded Sui wallet, read from the Privy user.
 * Apart from the signer (`privy-sui-wallet.ts`) so a page can find the wallet
 * without loading the key-format code, which loads when a transaction signs.
 */

type LinkedAccountLike = Readonly<{
  address?: string;
  chainType?: string;
  connectorType?: string;
  id?: string | null;
  imported?: boolean;
  publicKey?: string;
  recoveryMethod?: string;
  type?: string;
  walletClientType?: string;
}>;

type UserWithLinkedAccounts = Readonly<{
  linkedAccounts?: readonly LinkedAccountLike[];
}>;

export type EmbeddedSuiWallet = Readonly<{
  address: string;
  publicKey: string | null;
}>;

export function findEmbeddedSuiWallet(
  user: UserWithLinkedAccounts | null,
): EmbeddedSuiWallet | null {
  const wallet = user?.linkedAccounts?.find(
    (account) =>
      account.type === "wallet" &&
      account.chainType === "sui" &&
      account.connectorType === "embedded" &&
      account.walletClientType === "privy" &&
      account.imported === false &&
      typeof account.id === "string" &&
      account.recoveryMethod === "privy-v2",
  );
  if (!wallet?.address) return null;

  return {
    address: normalizeSuiAddress(wallet.address),
    publicKey: wallet.publicKey ?? null,
  };
}
