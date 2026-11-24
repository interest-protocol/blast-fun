import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  SOCIAL_WALLET_SIGN_IN_CHALLENGE_PATH,
  SOCIAL_WALLET_HINT_COOKIE,
  SOCIAL_WALLET_SESSION_PATH,
  socialWalletSignInChallengeSchema,
} from "@blast/core/modules/social/contracts/wallet-sign-in.ts";

/**
 * The browser side of wallet sign-in (contracts in
 * `modules/social/contracts/wallet-sign-in.ts`). Every call is a same-origin
 * fetch: the session cookie is HttpOnly and `SameSite=Strict`, so it travels
 * only with same-origin requests and script never reads it. The readable
 * hint cookie only says that a session may exist, so the page knows to read
 * `me` with the cookie (a visitor without it never does).
 */

/** The wallet that signs: a Sui wallet (dApp Kit) in the app, a stub in tests. */
export type WalletSigner = Readonly<{
  /** Connects (asking the user) and answers the account's address. */
  connect(): Promise<string>;
  /** Signs the challenge text as a Sui personal message; answers the serialized signature. */
  signPersonalMessage(message: string): Promise<string>;
  /** Forgets the connection: sign-in did not finish. */
  disconnect(): Promise<void>;
}>;

export type WalletSignInResult = "signed-in" | "cancelled" | "failed" | "rate-limited";

type Fetch = typeof globalThis.fetch;

/** Whether this browser holds the wallet session hint (a session may be live). */
export function hasWalletSessionHint(cookie: string): boolean {
  return cookie.split(";").some((part) => part.trim() === `${SOCIAL_WALLET_HINT_COOKIE}=1`);
}

/**
 * A wallet's refusal (closing Slush, rejecting the connection or the
 * signature) is a cancel; anything else is a failure. Wallet Standard
 * wallets reject with varied messages, so the words are matched.
 */
export function isWalletRejection(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /reject|denied|cancel|closed|declin/i.test(text);
}

async function post(fetchImpl: Fetch, path: string, body?: unknown, method = "POST"): Promise<Response> {
  return fetchImpl(path, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Connect, ask for a challenge, sign it and prove it: on success the
 * response has set the session cookies. A signed-in wallet stays connected,
 * so the first trade opens one wallet popup (sign) instead of two (connect,
 * then sign); any other outcome drops the connection. A 429 anywhere is
 * `rate-limited`.
 */
export async function signInWithWallet(signer: WalletSigner, fetchImpl: Fetch = gatedFetch): Promise<WalletSignInResult> {
  let address: string;
  try {
    address = await signer.connect();
  } catch (error) {
    return isWalletRejection(error) ? "cancelled" : "failed";
  }
  const result = await proveWallet(signer, address, fetchImpl);
  if (result !== "signed-in") await signer.disconnect().catch(() => undefined);
  return result;
}

async function proveWallet(signer: WalletSigner, address: string, fetchImpl: Fetch): Promise<WalletSignInResult> {
  try {
    const issued = await post(fetchImpl, SOCIAL_WALLET_SIGN_IN_CHALLENGE_PATH, { address });
    if (issued.status === 429) return "rate-limited";
    if (issued.status !== 200) return "failed";
    const challenge = socialWalletSignInChallengeSchema.safeParse(await issued.json());
    if (!challenge.success) return "failed";
    let signature: string;
    try {
      signature = await signer.signPersonalMessage(challenge.data.message);
    } catch (error) {
      return isWalletRejection(error) ? "cancelled" : "failed";
    }
    const proved = await post(fetchImpl, SOCIAL_WALLET_SESSION_PATH, {
      challenge_id: challenge.data.challenge_id,
      address,
      message: challenge.data.message,
      signature,
    });
    if (proved.status === 429) return "rate-limited";
    return proved.status === 201 ? "signed-in" : "failed";
  } catch {
    return "failed";
  }
}

/** Ends the wallet session (if any) and clears its cookies; false when the server could not be reached. */
export async function endWalletSession(fetchImpl: Fetch = gatedFetch): Promise<boolean> {
  try {
    return (await post(fetchImpl, SOCIAL_WALLET_SESSION_PATH, undefined, "DELETE")).ok;
  } catch {
    return false;
  }
}
