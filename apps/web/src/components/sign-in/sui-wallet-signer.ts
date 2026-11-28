"use client";

import { createDAppKit, getWalletUniqueIdentifier, type UiWallet } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { SLUSH_WALLET_NAME } from "@mysten/slush-wallet";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";

import { isWalletRejection, rememberedWalletName, SLUSH_WEB_WALLET_ID, WALLET_SIGN_IN_STORAGE_KEY as STORAGE_KEY, type WalletSigner } from "./wallet-sign-in-client.ts";
import type { SuiSignInMethod } from "./sign-in-flow";

/** The Slush web wallet's metadata, served by this app (`/api/social/sign-in/slush-metadata`). */
export const SLUSH_METADATA_PATH = "/api/social/sign-in/slush-metadata";

let dAppKit: SocialKit | null = null;
const walletIds = new Map<string, string>();

function rememberWallet(address: string, wallet: UiWallet): void {
  const canonical = normalizeSuiAddress(address);
  const id = getWalletUniqueIdentifier(wallet);
  walletIds.set(canonical, id);
  try {
    localStorage.setItem(`${STORAGE_KEY}:wallet-id:${canonical}`, id);
    localStorage.setItem(`${STORAGE_KEY}:wallet:${canonical}`, wallet.name);
  } catch {
    // Blocked storage keeps the wallet choice for this page only.
  }
}

function rememberedWalletId(address: string): string | null {
  const id = walletIds.get(address);
  if (id) return id;
  try {
    return localStorage.getItem(`${STORAGE_KEY}:wallet-id:${address}`);
  } catch {
    return null;
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

export function subscribeSuiSignInWallets(onWallets: (wallets: readonly SuiSignInMethod[]) => void): () => void {
  return socialDAppKit().stores.$wallets.subscribe((wallets) => {
    const installed: SuiSignInMethod[] = [];
    let slushWeb: SuiSignInMethod | undefined;

    for (const wallet of wallets) {
      if (!wallet.features.includes("sui:signPersonalMessage")) {
        continue;
      }

      const id = getWalletUniqueIdentifier(wallet);
      if (id === SLUSH_WEB_WALLET_ID) {
        slushWeb = { id, wallet, slush: true };
      } else {
        installed.push({ id, wallet, slush: wallet.name === SLUSH_WALLET_NAME });
      }
    }

    if (slushWeb) {
      installed.push(slushWeb);
    }
    onWallets(installed);
  });
}

/**
 * Reconnects, with no popup, to accounts the wallet already authorized (Slush
 * keeps its session in the browser); null when it remembers none. dApp Kit's
 * own autoConnect makes this same call, but only when the kit loads with the
 * page, and this one loads at the first trade. Its types leave `silent` out;
 * it is passed through to the wallet as is. A refusal is rethrown, so a wallet
 * that prompts anyway is not asked twice.
 */
async function silentConnect(kit: SocialKit, wallet: UiWallet) {
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
  const id = rememberedWalletId(expected);
  const legacyName = id === null ? (rememberedWalletName(expected) ?? SLUSH_WALLET_NAME) : null;
  const matchesWallet = (wallet: UiWallet) => id === null ? wallet.name === legacyName : getWalletUniqueIdentifier(wallet) === id;
  const authorized = connection.wallet && matchesWallet(connection.wallet)
    ? connection.wallet.accounts.find(matches)
    : undefined;
  if (connection.isConnected && authorized) return authorized;

  const wallet = kit.stores.$wallets.get().find(matchesWallet);
  if (!wallet) throw new Error(`${legacyName ?? "Your Sui wallet"} is not available in this browser. Install it, then try again.`);
  // After a reload nothing is connected: a wallet that already authorized this
  // address reconnects without a popup. A connected kit skips this: a silent
  // answer with no accounts would clear its selected account.
  const silent = connection.isConnected ? null : await silentConnect(kit, wallet);
  const restored = silent?.accounts.find(matches);
  if (restored) return restored;
  const { accounts } = await kit.connectWallet({ wallet });
  const account = accounts.find(matches);
  if (!account) throw new Error(`${wallet.name} has not authorized this wallet address. Connect the address shown in Blast, then try again.`);
  return account;
}

/**
 * The selected mainnet wallet connects and signs the challenge as a personal message. The wallet
 * session, not the connection, keeps the user signed in; the connection
 * stays so trades sign without reconnecting, and sign-out drops it
 * (`forgetWalletConnection`).
 */
export function suiWalletSigner(wallet: UiWallet): WalletSigner {
  const kit = socialDAppKit();
  let account: Awaited<ReturnType<typeof kit.connectWallet>>["accounts"][number] | null = null;
  return {
    async connect() {
      const { accounts } = await kit.connectWallet({ wallet });
      account = accounts[0] ?? null;
      if (!account) throw new Error(`${wallet.name} did not share an account.`);
      rememberWallet(account.address, wallet);
      return account.address;
    },
    async signPersonalMessage(message) {
      if (!account) throw new Error(`${wallet.name} is not connected.`);
      const signed = await kit.signPersonalMessage({ account, message: new TextEncoder().encode(message) });
      return signed.signature;
    },
    async disconnect() {
      account = null;
      await kit.disconnectWallet();
    },
  };
}
