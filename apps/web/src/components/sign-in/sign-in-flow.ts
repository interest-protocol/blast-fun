import type { UiWallet } from "@mysten/dapp-kit-react";

import { diagnosticMessage } from "#web/lib/errors.ts";
/**
 * Sign-in (FEATURE-MAP §8.2, OA-2, OA-11) as pure decisions: which method the
 * visitor pressed, what the sheet shows while it runs, how it ended, and who
 * the welcome toast greets. `SignIn.tsx` feeds them from Privy (X and Google
 * through Privy's OAuth) and the Sui wallet session.
 */

/**
 * Sui wallets prove an address directly; `wallet` (OA-12) offers EVM and
 * Solana wallets through Privy's own wallet list.
 */
export const SOCIAL_SIGN_IN_METHODS = ["x", "google"] as const;
type SocialSignInMethod = (typeof SOCIAL_SIGN_IN_METHODS)[number];
export type PrivySignInMethod = SocialSignInMethod | "wallet";
export type SuiSignInMethod = Readonly<{ id: string; wallet: UiWallet; slush?: boolean }>;
export type SignInMethod = PrivySignInMethod | SuiSignInMethod;

/** The name in "Waiting for …". */
export const SIGN_IN_METHOD_NAMES: Readonly<Record<PrivySignInMethod, string>> = {
  x: "X",
  google: "Google",
  wallet: "your wallet",
};

export const SIGN_IN_METHOD_LABELS: Readonly<Record<PrivySignInMethod, string>> = {
  x: "Continue with X",
  google: "Continue with Google",
  wallet: "Ethereum & Solana wallets",
};

/**
 * Privy's wallet login: its modal with the EVM and Solana
 * wallets the shared Privy app enables (OA-12). X and Google stay headless
 * OAuth, and Sui wallets use the web app's own sign-in.
 */
export const PRIVY_WALLET_LOGIN = Object.freeze({ loginMethods: ["wallet"], walletChainType: "ethereum-and-solana" } as const);

/** Privy's OAuth provider for each OAuth method. */
export const PRIVY_OAUTH_PROVIDERS = { x: "twitter", google: "google" } as const;

/**
 * Where an OAuth attempt survives its redirect: the method, so the page it
 * returns to can say how it ended. Session storage, this tab only.
 */
export const SIGN_IN_ATTEMPT_STORAGE_KEY = "blast.signIn";

export type SignInState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "waiting"; method: SignInMethod }>
  | Readonly<{ status: "cancelled"; method: SignInMethod }>
  | Readonly<{ status: "failed"; method: SignInMethod }>
  | Readonly<{ status: "rate-limited"; method: SignInMethod }>
  /** Privy did not become ready in time. */
  | Readonly<{ status: "stalled" }>;

export const SIGN_IN_IDLE: SignInState = Object.freeze({ status: "idle" });

/** Every method waits while one runs; all choices are disabled. */
export function methodsDisabled(state: SignInState): boolean {
  return state.status === "waiting";
}

/** The method showing "Waiting for …", if any. */
export function waitingMethod(state: SignInState): SignInMethod | null {
  return state.status === "waiting" ? state.method : null;
}

/** The line under the methods after an attempt that did not sign in (no line otherwise). */
export function signInMessage(state: SignInState, addingAccount = false): Readonly<{ text: string; alert: boolean }> | null {
  switch (state.status) {
    case "cancelled":
      return { text: diagnosticMessage(addingAccount ? "Sign-in was cancelled." : "Sign-in was cancelled. You are still signed out.", { code: "request_cancelled" }), alert: false };
    case "failed":
      return { text: diagnosticMessage(addingAccount ? "Sign-in did not finish. Try again." : "Sign-in did not finish. You are still signed out. Try again.", { code: "authentication_unavailable" }), alert: true };
    case "rate-limited":
      return { text: diagnosticMessage("Too many sign-in attempts. Wait a few minutes, then try again.", { code: "rate_limited" }), alert: true };
    case "stalled":
      return { text: diagnosticMessage("Sign-in could not start. Check your connection, then try again.", { code: "network_unavailable" }), alert: true };
    default:
      return null;
  }
}

/** Privy's error code for a visitor who closed or backed out of the provider. */
const PRIVY_CANCEL_CODES = new Set(["exited_auth_flow", "oauth_user_denied", "exited_link_flow"]);

/** The end of an OAuth attempt Privy reported as an error: backing out is a cancel, anything else a failure. */
export function oauthErrorState(method: SocialSignInMethod, code: string): SignInState {
  return PRIVY_CANCEL_CODES.has(code) ? { status: "cancelled", method } : { status: "failed", method };
}

/** The method an OAuth return belongs to, from session storage (anything else is not ours). */
export function storedAttempt(value: string | null): SocialSignInMethod | null {
  return value === "x" || value === "google" ? value : null;
}

/** Privy's modal reported how a wallet login ended: closing it is a cancel, anything else a failure. */
export function walletLoginErrorState(code: string): SignInState {
  return PRIVY_CANCEL_CODES.has(code) ? { status: "cancelled", method: "wallet" } : { status: "failed", method: "wallet" };
}
