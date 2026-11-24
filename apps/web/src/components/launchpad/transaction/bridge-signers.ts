// The wallet bridge's connection sequences over injected Privy and dApp Kit
// state, so the production bridge stays a thin hook adapter. Both signer kinds
// sign for the provider's `network`, never for a wallet library's own default.

import { SLUSH_WALLET_NAME } from "@mysten/slush-wallet";

import { findEmbeddedSuiWallet, type SignRawHash } from "#web/components/mission-control/privy-sui-wallet.ts";
import { privySigner, walletSigner, type LaunchpadSigner, type SignedTransaction } from "./signer.ts";

type WalletAccount = Readonly<{ address: string; chains: readonly string[] }>;

/** A direct wallet as dApp Kit reports it, plus the actions the bridge needs. */
export type DirectWalletState<Wallet extends Readonly<{ name: string }>, Account extends WalletAccount> = Readonly<{
  network: string;
  account: Account | null;
  wallet: Wallet | null;
  wallets: readonly Wallet[];
  connect(wallet: Wallet): Promise<readonly Account[]>;
  sign(transaction: string, account: Account): Promise<SignedTransaction>;
  /** Signs a personal message (a Wallet Proof challenge) with `account`; its serialized signature. */
  signPersonalMessage?(message: Uint8Array, account: Account): Promise<string>;
}>;

function directSigner<Wallet extends Readonly<{ name: string }>, Account extends WalletAccount>(
  state: DirectWalletState<Wallet, Account>,
  account: Account,
  walletName: string,
): LaunchpadSigner {
  const signMessage = state.signPersonalMessage;
  return walletSigner({
    walletName,
    account,
    network: state.network,
    signTransaction: ({ transaction }) => state.sign(transaction, account),
    ...(signMessage ? { signPersonalMessage: (message: Uint8Array) => signMessage(message, account) } : {}),
  });
}

/** The connected direct wallet, without prompting; null when none is connected. */
export function currentDirectWalletSigner<Wallet extends Readonly<{ name: string }>, Account extends WalletAccount>(
  state: DirectWalletState<Wallet, Account>,
): LaunchpadSigner | null {
  return state.account && state.wallet ? directSigner(state, state.account, state.wallet.name) : null;
}

/** Reuses the connected account, or connects Slush (else the first installed wallet). */
export async function connectDirectWalletSigner<Wallet extends Readonly<{ name: string }>, Account extends WalletAccount>(
  state: DirectWalletState<Wallet, Account>,
): Promise<LaunchpadSigner> {
  const current = currentDirectWalletSigner(state);
  if (current) return current;
  const target = state.wallets.find((wallet) => wallet.name === SLUSH_WALLET_NAME) ?? state.wallets[0];
  if (!target) throw new Error("No Sui wallet was found. Install Slush or another Sui wallet.");
  const account = (await state.connect(target))[0];
  if (!account) throw new Error(`${target.name} did not share an account.`);
  return directSigner(state, account, target.name);
}

type PrivyUser = Parameters<typeof findEmbeddedSuiWallet>[0];

/** Privy's session and wallet actions as the bridge sees them. */
export type PrivyState = Readonly<{
  network: string;
  /** Resolves once Privy has started. */
  ready(): Promise<Readonly<{ authenticated: boolean; user: PrivyUser }>>;
  /** Opens Privy sign-in and resolves with the signed-in user. */
  login(): Promise<NonNullable<PrivyUser>>;
  createWallet(): Promise<Readonly<{ user: PrivyUser }>>;
  signRawHash: SignRawHash;
  /** The session's current access token, for same-origin outcome links (`LaunchpadSigner.accessToken`). */
  accessToken?: () => Promise<string | null>;
}>;

/** The signed-in user's embedded Sui wallet as a signer; null when there is none. */
export function currentPrivySigner(
  state: Pick<PrivyState, "network" | "signRawHash" | "accessToken">,
  user: PrivyUser,
): LaunchpadSigner | null {
  const wallet = findEmbeddedSuiWallet(user);
  return wallet && privySigner({ wallet, signRawHash: state.signRawHash, network: state.network, accessToken: state.accessToken });
}

/** Signs in if needed and creates the embedded Sui wallet only when the user has none. */
export async function connectPrivySigner(state: PrivyState): Promise<LaunchpadSigner> {
  const session = await state.ready();
  const user = session.authenticated && session.user ? session.user : await state.login();
  const existing = currentPrivySigner(state, user);
  if (existing) return existing;
  const created = currentPrivySigner(state, (await state.createWallet()).user);
  if (!created) throw new Error("Privy did not return a Sui wallet.");
  return created;
}
