"use client";

import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SLUSH_WALLET_NAME } from "@mysten/slush-wallet";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";

import { isWalletRejection, type WalletSigner } from "./wallet-sign-in-client.ts";
import { SIGN_IN_METHOD_NAMES, type SuiSignInMethod } from "./sign-in-flow";

/** The Slush web wallet's metadata, served by this app (`/api/social/sign-in/slush-metadata`). */
export const SLUSH_METADATA_PATH = "/api/social/sign-in/slush-metadata";

/** Where the social sign-in's dApp Kit keeps its state, apart from Mission Control's and the launchpad's. */
const STORAGE_KEY = "blast:social:sign-in:v1";

let dAppKit: SocialKit | null = null;
const walletNames = new Map<string, string>();

function rememberWallet(address: string, name: string): void {
  const canonical = normalizeSuiAddress(address);
  walletNames.set(canonical, name);
  try {
    localStorage.setItem(`${STORAGE_KEY}:wallet:${canonical}`, name);
  } catch {
    // Blocked storage keeps the wallet choice for this page only.
  }
}

function rememberedWallet(address: string): string | null {
  try {
    return walletNames.get(address) ?? localStorage.getItem(`${STORAGE_KEY}:wallet:${address}`) ?? null;
  } catch {
    return walletNames.get(address) ?? null;
  }
}

function createSocialDAppKit() {
  return createDAppKit({
    networks: ["mainnet"],
    defaultNetwork: "mainnet",
    createClient: (network) => new SuiGrpcClient({ network, baseUrl: SUI_MAINNET_GRPC_URL }),
    // Registers the Slush web wallet (its metadata from this origin: the CSP
    // refuses api.slush.app); the Slush extension registers itself.
    slushWalletConfig: { appName: "Blast", metadataApiUrl: SLUSH_METADATA_PATH },
    storageKey: STORAGE_KEY,
    autoConnect: false,
  });
}

/**
 * The social pages' one dApp Kit (Sui wallets, mainnet only), built on first use in
 * the browser. Sign-in signs a personal message with it; the coins sheet
 * (UI-14) signs a wallet session's withdrawals with it before submission.
 */
export function socialDAppKit(): SocialKit {
  dAppKit ??= createSocialDAppKit();
  return dAppKit;
}

type SocialKit = ReturnType<typeof createSocialDAppKit>;
type KitWallet = Parameters<SocialKit["connectWallet"]>[0]["wallet"];

/**
 * Reconnects, with no popup, to accounts the wallet already authorized (Slush
 * keeps its session in the browser); null when it remembers none. dApp Kit's
 * own autoConnect makes this same call, but only when the kit loads with the
 * page, and this one loads at the first trade. Its types leave `silent` out;
 * it is passed through to the wallet as is. A refusal is rethrown, so a wallet
 * that prompts anyway is not asked twice.
 */
async function silentConnect(kit: SocialKit, wallet: KitWallet) {
  const input = { wallet, silent: true } as Parameters<SocialKit["connectWallet"]>[0];
  return kit.connectWallet(input).catch((error: unknown) => {
    if (isWalletRejection(error)) throw error;
    return null;
  });
}

/**
 * Sign-out: drops the wallet connection sign-in kept. After a reload the kit
 * is not connected, so it first reconnects silently to Slush's saved session,
 * then disconnects, which removes that session from the browser.
 */
export async function forgetWalletConnection(): Promise<void> {
  const kit = socialDAppKit();
  if (!kit.stores.$connection.get().isConnected) {
    const slush = kit.stores.$wallets.get().find((candidate) => candidate.name === SLUSH_WALLET_NAME);
    if (!slush || !(await silentConnect(kit, slush).catch(() => null))) return;
  }
  await kit.disconnectWallet();
}

/** Signing uses the session's wallet and authorized address, independently of its selected account. */
export async function suiSigningAccount(address: string) {
  const kit = socialDAppKit();
  const expected = normalizeSuiAddress(address);
  const matches = (account: { address: string }) => normalizeSuiAddress(account.address) === expected;
  const connection = kit.stores.$connection.get();
  const name = rememberedWallet(expected) ?? SLUSH_WALLET_NAME;
  const authorized = connection.wallet?.name === name
    ? connection.wallet.accounts.find(matches)
    : undefined;
  if (connection.isConnected && authorized) return authorized;

  const wallet = kit.stores.$wallets.get().find((candidate) => candidate.name === name);
  if (!wallet) throw new Error(`${name} is not available in this browser. Install it, then try again.`);
  // After a reload nothing is connected: a wallet that already authorized this
  // address reconnects without a popup. A connected kit skips this: a silent
  // answer with no accounts would clear its selected account.
  const silent = connection.isConnected ? null : await silentConnect(kit, wallet);
  const restored = silent?.accounts.find(matches);
  if (restored) return restored;
  const { accounts } = await kit.connectWallet({ wallet });
  const account = accounts.find(matches);
  if (!account) throw new Error(`${name} has not authorized this wallet address. Connect the address shown in Blast, then try again.`);
  return account;
}

/**
 * Sui wallets through Mysten's dApp Kit, mainnet only. Slush can fall back to
 * its web wallet; Nightly, Scallop, and Mahalo need an installed extension.
 * It connects and signs the challenge as a personal message. The wallet
 * session, not the connection, keeps the user signed in; the connection
 * stays so trades sign without reconnecting, and sign-out drops it
 * (`forgetWalletConnection`).
 */
export function suiWalletSigner(method: SuiSignInMethod): WalletSigner {
  const kit = socialDAppKit();
  const name = SIGN_IN_METHOD_NAMES[method];
  let account: Awaited<ReturnType<typeof kit.connectWallet>>["accounts"][number] | null = null;
  return {
    async connect() {
      const wallet = kit.stores.$wallets.get().find((candidate) => candidate.name.toLowerCase().startsWith(name.toLowerCase()));
      if (!wallet) throw new Error(`${name} is not available in this browser. Install it, then try again.`);
      const { accounts } = await kit.connectWallet({ wallet });
      account = accounts[0] ?? null;
      if (!account) throw new Error(`${name} did not share an account.`);
      rememberWallet(account.address, wallet.name);
      return account.address;
    },
    async signPersonalMessage(message) {
      if (!account) throw new Error(`${name} is not connected.`);
      const signed = await kit.signPersonalMessage({ account, message: new TextEncoder().encode(message) });
      return signed.signature;
    },
    async disconnect() {
      account = null;
      await kit.disconnectWallet();
    },
  };
}
