import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";

import {
  privySuiSigner,
  type EmbeddedSuiWallet,
  type SignRawHash,
} from "#web/components/mission-control/privy-sui-wallet.ts";
import type { SignerKind } from "./action-machine.ts";

export type SignedTransaction = Readonly<{ bytes: string; signature: string }>;

/**
 * The one signer contract every launchpad action uses, whether the key lives
 * in a Privy embedded wallet or a direct Sui wallet. It carries no Blast
 * Account, member session, or backend identity: signing needs only a wallet.
 */
export type LaunchpadSigner = Readonly<{
  kind: SignerKind;
  label: string;
  address: string;
  /** The Sui chain the signer will sign for (`sui:<network>`); null when it names none. */
  chain: string | null;
  /** A direct connection can change even after the action's page has unmounted. */
  isConnectedAccount?: () => boolean;
  /** Signs exactly these transaction bytes. It never executes them. */
  signTransaction(bytes: Uint8Array): Promise<SignedTransaction>;
  /**
   * Privy only: the signed-in session's current access token (null when
   * there is none). The launchpad sends it only same-origin, with a completed
   * outcome's report, so the server can link this browser's visitor to the
   * outcome when the session's wallet is its sender. Direct wallets have none.
   */
  accessToken?: () => Promise<string | null>;
  /**
   * Direct wallets only: signs a personal message (a Wallet Proof challenge
   * for a launchpad write), never a transaction, and returns its serialized
   * signature. Privy authors write with their session instead.
   */
  signPersonalMessage?: (message: Uint8Array) => Promise<string>;
  /**
   * A Blast wallet session's wallet (Slush and others) on Blast's gas (owner
   * ruling 2026-11-20): it asks the sponsor like a Privy wallet, by the
   * session's cookie. A direct wallet with no Blast session pays its own.
   */
  sponsored?: boolean;
}>;

/** Whether Blast's gas pays for this signer's transactions: a Privy wallet, or a Blast wallet session's. */
export function blastPaysGas(signer: Pick<LaunchpadSigner, "kind" | "sponsored">): boolean {
  return signer.kind === "privy" || signer.sponsored === true;
}

/**
 * A Privy embedded wallet. Its key signs raw digests with no chain of its own,
 * so it signs for the network the app executes on.
 */
export function privySigner({
  wallet,
  signRawHash,
  network,
  accessToken,
}: Readonly<{
  wallet: EmbeddedSuiWallet;
  signRawHash: SignRawHash;
  network: string;
  accessToken?: () => Promise<string | null>;
}>): LaunchpadSigner {
  const signer = privySuiSigner(wallet, signRawHash);
  return {
    kind: "privy",
    label: "Privy wallet",
    address: signer.toSuiAddress(),
    chain: `sui:${network}`,
    signTransaction: (bytes) => signer.signTransaction(bytes),
    ...(accessToken ? { accessToken } : {}),
  };
}

export type WalletSignTransaction = (input: Readonly<{ transaction: string }>) => Promise<SignedTransaction>;

/**
 * A direct Sui wallet account. Its chain is the app network only when the
 * account supports it; otherwise it reports the chain the wallet is on.
 */
export function walletSigner({
  walletName,
  account,
  network,
  signTransaction,
  signPersonalMessage,
}: Readonly<{
  walletName: string;
  account: Readonly<{ address: string; chains: readonly string[] }>;
  network: string;
  signTransaction: WalletSignTransaction;
  signPersonalMessage?: (message: Uint8Array) => Promise<string>;
}>): LaunchpadSigner {
  const wanted = `sui:${network}`;
  const chain = account.chains.includes(wanted)
    ? wanted
    : (account.chains.find((candidate) => candidate.startsWith("sui:")) ?? null);
  return {
    kind: "wallet",
    label: walletName,
    address: normalizeSuiAddress(account.address),
    chain,
    signTransaction: (bytes) => signTransaction({ transaction: toBase64(bytes) }),
    ...(signPersonalMessage ? { signPersonalMessage } : {}),
  };
}

const REJECTION = /\b(reject(ed|ion)?|denied|declined|cancell?ed)\b/i;

/** Whether a signing error means the user refused, as opposed to a failure. */
export function isUserRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return code === 4001 || REJECTION.test(error.message);
}
