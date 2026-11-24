import { diagnosticMessage, responseError, type ErrorDiagnostic } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { SOCIAL_ME_PATH, socialXHandleRefreshSchema, socialMeResponseSchema, type SocialMeAccount } from "@blast/core/web/contracts/me.ts";

import { socialRequestAuth, type SocialRequestAuth } from "./social-fetch";
import { postCreateAccount } from "./create-account-client";

type AccountRequest = Readonly<{
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}>;

/** The `me` path every social page reads the caller's account from. */
export const SOCIAL_ME_URL = SOCIAL_ME_PATH;

/** Best-effort refresh after Privy login; provider failures must not prevent sign-in. */
export async function refreshSocialXHandle(input: Readonly<{
  getAccessToken: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const auth = await socialRequestAuth(input.getAccessToken);
  if (!auth?.headers.authorization || input.signal?.aborted) return false;
  try {
    const response = await (input.fetch ?? gatedFetch)(`${SOCIAL_ME_URL}/x-handle`, {
      method: "POST",
      credentials: auth.credentials,
      headers: auth.headers,
      signal: input.signal,
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    const parsed = socialXHandleRefreshSchema.safeParse(body);
    return parsed.success && parsed.data.updated;
  } catch {
    return false;
  }
}

/**
 * - `loading`: the session, `me` read or automatic account creation is in flight;
 * - `signed_out`: no Privy or wallet session, or `me` refused it (401);
 * - `ready`: the caller's existing or newly created Blast Account is saved;
 * - `error`: the read or creation failed (network, 429, 503 or an unexpected body).
 */
export type SocialAccountStatus = "loading" | "signed_out" | "ready" | "error";

export type SocialAccountState = ErrorDiagnostic & Readonly<{
  status: SocialAccountStatus;
  account: SocialMeAccount | null;
  message?: string;
}>;

export const SOCIAL_ACCOUNT_LOADING: SocialAccountState = Object.freeze({ status: "loading", account: null });
export const SOCIAL_ACCOUNT_SIGNED_OUT: SocialAccountState = Object.freeze({ status: "signed_out", account: null });
export const SOCIAL_ACCOUNT_ERROR: SocialAccountState = Object.freeze({ status: "error", account: null });

/** Privy's session as the hook sees it (`usePrivy()`). */
export type SocialPrivySession = Readonly<{
  ready: boolean;
  authenticated: boolean;
  getAccessToken: () => Promise<string | null>;
}>;

/**
 * Reads `GET /api/social/me` as the caller: its Privy access token, else the
 * wallet session cookie (`socialRequestAuth`). A 401 is `signed_out`; a
 * well-formed 200 is `ready`; anything else (including a network failure) is
 * `error`. An aborted read rethrows the abort so the caller can drop it.
 */
async function readSocialAccount(input: AccountRequest): Promise<SocialAccountState> {
  const request = input.fetch ?? gatedFetch;
  const auth = await socialRequestAuth(input.getAccessToken);
  if (!auth) return { ...SOCIAL_ACCOUNT_ERROR, code: "authentication_unavailable", message: diagnosticMessage("Sign in again to read your account.", { code: "authentication_unavailable" }) };
  const send = (using: SocialRequestAuth) => request(SOCIAL_ME_URL, {
    cache: "no-store",
    credentials: using.credentials,
    headers: using.headers,
    signal: input.signal,
  });
  let response: Response;
  try {
    response = await send(auth);
    // A refused token is asked for again once before the viewer reads as signed out (see `callSocialApi`).
    if (response.status === 401) {
      const again = await socialRequestAuth(input.getAccessToken);
      if (again?.headers.authorization && again.headers.authorization !== auth.headers.authorization && !input.signal?.aborted) response = await send(again);
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return { ...SOCIAL_ACCOUNT_ERROR, code: "network_unavailable", message: diagnosticMessage("Your account could not load. Check your connection and retry.", { code: "network_unavailable" }) };
  }
  if (response.status === 401) return SOCIAL_ACCOUNT_SIGNED_OUT;
  const body: unknown = await response.json().catch(() => null);
  const parsed = socialMeResponseSchema.safeParse(body);
  if (response.status !== 200 || !parsed.success) {
    const error = responseError(body, response);
    return { ...SOCIAL_ACCOUNT_ERROR, code: error.code, httpStatus: error.httpStatus, ...(error.requestId ? { requestId: error.requestId } : {}), message: error.message };
  }
  return { status: "ready", account: parsed.data.account };
}

/** New sessions receive saved random defaults before the shared account query becomes ready. */
export async function fetchSocialAccount(input: AccountRequest): Promise<SocialAccountState> {
  const state = await readSocialAccount(input);
  if (state.status !== "ready" || state.account) return state;
  const created = await postCreateAccount(input);
  if (created.status === "created") return { status: "ready", account: created.account };
  if (created.status === "refused" && created.code === "unauthorized") return SOCIAL_ACCOUNT_SIGNED_OUT;
  if (created.status === "refused" && created.code === "account_exists") {
    const refreshed = await readSocialAccount(input);
    return refreshed.status === "ready" && !refreshed.account ? { ...SOCIAL_ACCOUNT_ERROR, code: "invalid_response", message: diagnosticMessage("Your account could not be created. Try again.", { code: "invalid_response" }) } : refreshed;
  }
  return { ...SOCIAL_ACCOUNT_ERROR, code: created.code, ...(created.httpStatus != null ? { httpStatus: created.httpStatus } : {}), ...(created.requestId ? { requestId: created.requestId } : {}), message: diagnosticMessage("Your account could not be created. Try again.", created) };
}

/**
 * What the hook shows before (or instead of) a `me` read, or null when it
 * must read `me`: Privy still starting is loading; neither a Privy session
 * nor a wallet session hint is signed out (OA-16).
 */
export function socialAccountFromSession(
  session: Pick<SocialPrivySession, "ready" | "authenticated"> & Readonly<{ wallet?: boolean }>,
): SocialAccountState | null {
  if (!session.ready) return SOCIAL_ACCOUNT_LOADING;
  if (!session.authenticated && !session.wallet) return SOCIAL_ACCOUNT_SIGNED_OUT;
  return null;
}

const noAccessToken = async () => null;

/**
 * The sessions and the `me` read, as the viewer every gate below
 * `SocialSession` sees: signed in through Privy, or through a wallet session
 * (its hint) that `me` has not refused.
 */
export function socialViewerProps(
  privy: Readonly<{
    ready: boolean;
    authenticated: boolean;
    getAccessToken: () => Promise<string | null>;
    logout: () => Promise<void>;
  }>,
  account: SocialAccountState,
  walletActive = false,
): Readonly<{
  signedIn: boolean;
  sessionPending: boolean;
  callsign: string | null;
  getAccessToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
}> {
  return {
    signedIn: account.status !== "signed_out" && ((privy.ready && privy.authenticated) || walletActive),
    sessionPending: account.status === "loading",
    callsign: account.account?.callsign ?? null,
    getAccessToken: privy.ready && privy.authenticated ? privy.getAccessToken : noAccessToken,
    signOut: privy.logout,
  };
}
