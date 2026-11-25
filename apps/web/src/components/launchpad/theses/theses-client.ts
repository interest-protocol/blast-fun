import { browserCsrfToken } from "#web/lib/web-security/csrf-client.ts";
import { CSRF_HEADER_NAME } from "@blast/core/lib/web-security/csrf-contract.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import { parsePublicPost, parseThesisListResponse, type ThesisListResponse } from "@blast/core/modules/launchpad-social/list-contract.ts";
import type { PostInput } from "@blast/core/modules/launchpad-social/post-contract.ts";
import type { PublicPost } from "@blast/core/modules/launchpad-social/post-contract.ts";

/**
 * The browser's side of a launch's theses: one page of the public list
 * (`GET /api/launchpad/theses`), and publishing one post through the
 * protected `social_post` write with a Privy session or a Wallet Proof.
 * Every answer is private and current, so reads bypass the HTTP cache.
 */

/** A served list, a refused request ("invalid", 400), or one that did not complete or broke the contract (null). */
export type ThesesAnswer = ThesisListResponse | "invalid" | null;

const LIST = "/api/launchpad/theses";

export function thesesUrl(launchId: string, cursor: string | null = null): string {
  const params = new URLSearchParams({ launchId });
  if (cursor !== null) params.set("cursor", cursor);
  return `${LIST}?${params}`;
}

export async function readTheses(
  launchId: string,
  cursor: string | null,
  options: Readonly<{ signal?: AbortSignal; fetcher?: typeof fetch }> = {},
): Promise<ThesesAnswer> {
  const fetcher = options.fetcher ?? gatedFetch;
  try {
    const response = await fetcher(thesesUrl(launchId, cursor), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: options.signal,
    });
    if (response.status === 400) return "invalid";
    if (response.status !== 200 && response.status !== 503) return null;
    return parseThesisListResponse(await response.json(), launchId);
  } catch {
    return null;
  }
}

/** Who posts: a Privy session's access token, or a wallet that signs a Wallet Proof challenge. */
export type PostCredential =
  | Readonly<{ kind: "privy"; accessToken: string }>
  | Readonly<{ kind: "wallet"; address: string; signPersonalMessage(message: Uint8Array): Promise<string> }>;

export type PublishOutcome =
  | Readonly<{ status: "published"; post: PublicPost }>
  /** The author can change the post or its credential: nothing was posted. */
  | Readonly<{ status: "refused" | "unauthorized" | "cancelled" | "unavailable"; message: string }>;

const NOTHING = "Nothing was posted.";

const REFUSALS: Readonly<Record<string, Readonly<{ status: "refused" | "unauthorized"; message: string }>>> = {
  LAUNCHPAD_STANCE_REQUIRED: {
    status: "refused",
    message: `Choose a stance. The posting wallet is not this launch's creator, so this would be a community thesis, which needs Bullish, Bearish or Neutral. ${NOTHING}`,
  },
  LAUNCHPAD_PAYLOAD_TOO_LARGE: { status: "refused", message: `The post is too large to send. Shorten the text or the disclosure. ${NOTHING}` },
  LAUNCHPAD_AUTH_REQUIRED: { status: "unauthorized", message: `Sign in or prove wallet control to post. ${NOTHING}` },
  LAUNCHPAD_AUTH_INVALID: { status: "unauthorized", message: `Your sign-in or wallet proof was not accepted or has expired. Sign in or prove the wallet again. ${NOTHING}` },
  LAUNCHPAD_FORBIDDEN: { status: "refused", message: `Blast refused this post: a disclosed wallet must be the wallet you post with. ${NOTHING}` },
  LAUNCHPAD_NOT_FOUND: { status: "refused", message: `This launch is not indexed by Blast right now, so it cannot take posts. ${NOTHING}` },
  LAUNCHPAD_CONFLICT: { status: "refused", message: `The thesis changed while you wrote. Reload them and try again. ${NOTHING}` },
};

const INVALID = {
  status: "refused",
  message: `Blast could not accept this post. Check the text (no control characters), the links (https only, at most 3) and the disclosure. ${NOTHING}`,
} as const;

function unavailable(message: string): PublishOutcome {
  return { status: "unavailable", message };
}

const OFFLINE = unavailable(`Posting did not complete: the connection failed. ${NOTHING} Try again shortly.`);

/** A refusal's outcome from its status and code; the server's own words are never shown. */
async function refusal(response: Response): Promise<PublishOutcome> {
  if (response.status === 429) {
    const wait = response.headers.get("retry-after");
    const when = wait && /^[0-9]{1,6}$/.test(wait) ? `in ${wait} s` : "later";
    return unavailable(`Too many posts from this connection. Try again ${when}. ${NOTHING}`);
  }
  if (response.status >= 500) return unavailable(`Posting is unavailable right now. ${NOTHING} Try again shortly.`);
  let code: unknown;
  try {
    code = ((await response.json()) as { error?: { code?: unknown } }).error?.code;
  } catch {
    code = null;
  }
  const known = typeof code === "string" ? REFUSALS[code] : undefined;
  if (known) return known;
  return response.status === 401 ? REFUSALS.LAUNCHPAD_AUTH_INVALID : INVALID;
}

type Challenge = Readonly<{ challengeId: string; address: string; message: string }>;

async function walletProof(
  credential: Extract<PostCredential, { kind: "wallet" }>,
  send: (url: string, payload: unknown) => Promise<Response>,
): Promise<{ proof: Challenge & { signature: string } } | PublishOutcome> {
  const response = await send("/api/launchpad/wallet-proofs", { action: "social_post", address: credential.address });
  if (response.status !== 201) return refusal(response);
  let challenge: Challenge;
  try {
    const body = (await response.json()) as { challenge?: Partial<Challenge> };
    const { challengeId, address, message } = body.challenge ?? {};
    if (typeof challengeId !== "string" || typeof address !== "string" || typeof message !== "string") throw new TypeError();
    challenge = { challengeId, address, message };
  } catch {
    return unavailable(`Blast's wallet proof could not be read. ${NOTHING} Try again shortly.`);
  }
  let signature: string;
  try {
    signature = await credential.signPersonalMessage(new TextEncoder().encode(challenge.message));
  } catch {
    return { status: "cancelled", message: `The wallet did not sign the proof. ${NOTHING}` };
  }
  return { proof: { ...challenge, signature } };
}

/**
 * Publishes one post. It first makes sure the CSRF cookie exists; a wallet
 * author then gets a Wallet Proof challenge for `social_post` and signs its
 * exact message (a personal message, never a transaction). The post's own
 * answer is checked like the list's: an answer that breaks the contract is
 * reported as unconfirmed, since the post may exist.
 */
export async function publishThesis({
  input,
  credential,
  idempotencyKey,
  fetcher = gatedFetch,
  csrf = browserCsrfToken,
}: Readonly<{
  input: PostInput;
  credential: PostCredential;
  /** The same key on a retry of the same draft: the server answers with the first try's post instead of writing a second. */
  idempotencyKey?: string;
  fetcher?: typeof fetch;
  csrf?: () => string | null;
}>): Promise<PublishOutcome> {
  try {
    let token = csrf();
    if (!token) {
      await fetcher("/api/launchpad/csrf", { credentials: "same-origin" });
      token = csrf();
    }
    if (!token) return unavailable(`Posting is unavailable: this browser did not keep Blast's request cookie. ${NOTHING}`);
    const headers: Record<string, string> = { "Content-Type": "application/json", [CSRF_HEADER_NAME]: token };
    const send = (url: string, payload: unknown, extra: Record<string, string> = {}) =>
      fetcher(url, { method: "POST", credentials: "same-origin", headers: { ...headers, ...extra }, body: JSON.stringify(payload) });

    const retry: Record<string, string> = idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {};
    let response: Response;
    if (credential.kind === "privy") {
      response = await send(LIST, { input }, { ...retry, Authorization: `Bearer ${credential.accessToken}` });
    } else {
      const proven = await walletProof(credential, send);
      if (!("proof" in proven)) return proven;
      const { challengeId, address, message, signature } = proven.proof;
      response = await send(LIST, { input, proof: { challengeId, address, message, signature } }, retry);
    }
    if (response.status !== 201) return refusal(response);
    try {
      const { post } = (await response.json()) as { post?: unknown };
      return { status: "published", post: parsePublicPost(post, input.launchId) };
    } catch {
      return unavailable("Your post could not be confirmed. Reload the thesis to see whether it was posted.");
    }
  } catch {
    return OFFLINE;
  }
}
