import { diagnosticMessage } from "#web/lib/errors.ts";
import type { SocialAccountWallet } from "@blast/core/web/contracts/me.ts";
import type { SocialLinkedWalletKind } from "@blast/core/web/contracts/wallets.ts";

import type { ApiResult, TokenSource } from "#web/components/social/social-api.ts";
import { linkWallet, requestWalletChallenge } from "./settings-client";

/**
 * "Link a Sui wallet" (FEATURE-MAP §14.3, T-017): pick a wallet, connect it,
 * get a challenge for its address, sign the challenge as a personal message
 * (no transaction, no gas), and link. Pure orchestration over an injected
 * wallet adapter, so the steps and their failures are testable without a
 * browser wallet.
 */

/** The design's wallet buttons, in order, with the mark each shows. */
export const LINK_WALLETS = [
  { id: "slush", name: "Slush", kind: "slush" },
  { id: "suiet", name: "Suiet", kind: "external" },
  { id: "phantom", name: "Phantom", kind: "external" },
  { id: "nightly", name: "Nightly", kind: "external" },
  { id: "scallop", name: "Scallop", kind: "external" },
  { id: "mahalo", name: "Mahalo", kind: "external" },
] as const satisfies readonly Readonly<{ id: string; name: string; kind: SocialLinkedWalletKind }>[];

/**
 * A wallet's mark in the link sheet (OA-24): a neutral monogram, its name's
 * first letter. The earlier gate drew Suiet and Phantom with other projects'
 * coin marks (SuiNS, NAVI), which said something untrue about each wallet.
 */
export function walletMonogram(name: string): string {
  return name.charAt(0).toUpperCase();
}

export type LinkWalletChoice = (typeof LINK_WALLETS)[number];
export type LinkWalletId = LinkWalletChoice["id"];

export const LINK_COPY = {
  title: "Link a Sui wallet",
  lead: "You'll sign one message. Nothing is sent and it costs no gas.",
  signing: (name: string) => `Sign in ${name}`,
} as const;

/** A connected wallet account that can sign a personal message. */
export type ConnectedWallet = Readonly<{ address: string; sign(message: Uint8Array): Promise<string> }>;

export interface WalletAdapter {
  /** Connects the named wallet (asking the person) and returns its account; throws `WalletNotInstalledError` without it. */
  connect(name: string): Promise<ConnectedWallet>;
  /** Forgets the connection after the link (best effort). */
  release?(): Promise<void>;
}

export class WalletNotInstalledError extends Error {
  readonly walletName: string;

  constructor(walletName: string) {
    super(`${walletName} is not installed.`);
    this.name = "WalletNotInstalledError";
    this.walletName = walletName;
  }
}

export type LinkOutcome =
  | Readonly<{ status: "linked"; wallet: SocialAccountWallet; name: string }>
  | Readonly<{ status: "cancelled"; message: string }>
  | Readonly<{ status: "failed"; message: string }>;

export const LINK_MESSAGES = {
  cancelled: "Signing was cancelled. Nothing was linked.",
  notInstalled: (name: string) => `${name} isn't installed in this browser. Install it, then try again.`,
  taken: "That wallet belongs to another Blast account. Nothing was linked.",
  invalid: "That signature didn't match the wallet. Nothing was linked. Try again.",
  limited: (seconds: number | null) =>
    seconds ? `Too many tries. Try again in ${Math.ceil(seconds / 60)} min. Nothing was linked.` : "Too many tries. Try again later. Nothing was linked.",
  session: "Your session ended. Sign in again, then link the wallet.",
  failed: "The wallet couldn't be linked. Nothing changed. Try again.",
} as const;

/** Whether a wallet error means the person said no (closed the popup or rejected the request). */
export function isRejection(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  return code === 4001 || /reject|denied|declin|cancel|closed|dismiss/i.test(text);
}

function refusal(result: Exclude<ApiResult<unknown>, { status: "ok" }>): LinkOutcome {
  if (result.status === "refused") {
    if (result.code === "wallet_taken") return { status: "failed", message: diagnosticMessage(LINK_MESSAGES.taken, result) };
    if (result.code === "invalid_signature") return { status: "failed", message: diagnosticMessage(LINK_MESSAGES.invalid, result) };
    if (result.code === "rate_limited") return { status: "failed", message: diagnosticMessage(LINK_MESSAGES.limited(result.retryAfterSeconds), result) };
    if (result.code === "unauthorized") return { status: "failed", message: diagnosticMessage(LINK_MESSAGES.session, result) };
  }
  return { status: "failed", message: diagnosticMessage(LINK_MESSAGES.failed, result) };
}

/** Runs the whole link for `choice`. Never throws: every way out is an outcome. */
export async function runWalletLink(
  input: Readonly<{ choice: LinkWalletChoice; adapter: WalletAdapter; getAccessToken: TokenSource }>,
): Promise<LinkOutcome> {
  const { choice, adapter } = input;
  const api = { getAccessToken: input.getAccessToken };
  try {
    let connected: ConnectedWallet;
    try {
      connected = await adapter.connect(choice.name);
    } catch (error) {
      if (error instanceof WalletNotInstalledError) return { status: "failed", message: diagnosticMessage(LINK_MESSAGES.notInstalled(choice.name), { code: "request_failed" }) };
      return isRejection(error) ? { status: "cancelled", message: diagnosticMessage(LINK_MESSAGES.cancelled, { code: "wallet_rejected" }) } : { status: "failed", message: diagnosticMessage(LINK_MESSAGES.failed, { code: "request_failed" }) };
    }
    const challenge = await requestWalletChallenge(api, connected.address);
    if (challenge.status !== "ok") return refusal(challenge);
    let signature: string;
    try {
      signature = await connected.sign(new TextEncoder().encode(challenge.body.message));
    } catch (error) {
      return isRejection(error) ? { status: "cancelled", message: diagnosticMessage(LINK_MESSAGES.cancelled, { code: "wallet_rejected" }) } : { status: "failed", message: diagnosticMessage(LINK_MESSAGES.failed, { code: "request_failed" }) };
    }
    const linked = await linkWallet(api, challenge.body, signature, choice.kind);
    if (linked.status !== "ok") return refusal(linked);
    return { status: "linked", wallet: linked.body.wallet, name: choice.name };
  } finally {
    await adapter.release?.().catch(() => undefined);
  }
}
