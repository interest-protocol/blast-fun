import { randomUUID } from "node:crypto";

import { recordMetric } from "@blast/core/lib/metrics.ts";
import {
  WalletChallengeError,
  canonicalSuiAddress,
  type WalletChallengeService,
} from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import {
  SOCIAL_WALLET_SIGN_IN_CHALLENGE_ROUTE,
  SOCIAL_WALLET_SESSION_CREATE_ROUTE,
  SOCIAL_WALLET_SESSION_DELETE_ROUTE,
  SOCIAL_WALLET_SESSION_TTL_MS,
  socialWalletSessionRequestSchema,
  socialWalletSignInChallengeRequestSchema,
  type SocialWalletChallengeResponse,
  type SocialWalletSessionResponse,
  type SocialWalletSignOutResponse,
} from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { readSocialBody, readSocialJsonWithSchema, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import {
  clearedWalletSessionCookies,
  createWalletSession,
  createWalletSessionToken,
  readWalletSessionToken,
  revokeWalletSession,
  walletSessionCookies,
} from "@blast/core/modules/social/wallet-sign-in/sessions.ts";

/** The proof body may carry a zkLogin or passkey signature: up to 12 KiB. */
const SESSION_BODY_LIMIT_BYTES = 12 * 1_024;
const ATTEMPT_LINE = /(?:^|\n)Attempt: (sign-in-[0-9a-f-]{36})(?:\n|$)/;

export type SocialWalletSignInDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The site origin: challenges are bound to it and every request must come from it. */
  expectedOrigin: string;
  /**
   * Mission Control's wallet challenges (action `sign_in`). Its own limiter
   * gets `<client ip>|<address>` as the key (production: the `wallet` bucket,
   * per IP, address and operation), after this module's per-IP bucket.
   */
  challenges: Pick<WalletChallengeService, "issue" | "verify">;
  clock?: () => Date;
  createToken?: () => string;
  createAttemptId?: () => string;
}>;


function headersWithCookies(response: Response, cookies: readonly string[]): Response {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

/**
 * `POST /api/social/sign-in/challenge` and `POST|DELETE …/session`
 * (contracts in `contracts/wallet-sign-in.ts`). Order for each: the social
 * kit (an `Origin` other than the site's, the IP bucket), then this module's
 * own origin rule: `Origin` must be present, and the cookie routes refuse a
 * cross-site `Sec-Fetch-Site`. The challenge service then counts its own bucket per IP
 * and address. A refusal never says why a proof failed beyond
 * `wallet_proof_invalid`, and no address, token or signature reaches a log
 * line or a metric.
 */
export function createSocialWalletSignInRoutes(dependencies: SocialWalletSignInDependencies) {
  const { kit, expectedOrigin, challenges } = dependencies;
  const clock = dependencies.clock ?? (() => new Date());
  const createToken = dependencies.createToken ?? createWalletSessionToken;
  const createAttemptId = dependencies.createAttemptId ?? (() => `sign-in-${randomUUID()}`);

  /** `Origin` must be the site's; a cookie route also refuses another site's fetch metadata. */
  function requireOrigin(request: Request, cookieRoute: boolean): void {
    if (request.headers.get("origin") !== expectedOrigin) throw new SocialRouteError("origin_invalid");
    const site = request.headers.get("sec-fetch-site");
    if (cookieRoute && site !== null && site !== "same-origin") throw new SocialRouteError("origin_invalid");
  }

  function metric(step: string, outcome: string): void {
    recordMetric("social.wallet_sign_in", { step, outcome });
  }

  return Object.freeze({
    challenge: Object.freeze({
      POST: kit.route({ name: SOCIAL_WALLET_SIGN_IN_CHALLENGE_ROUTE, auth: "none", bucket: "social_wallet_sign_in" }, async (context) => {
        requireOrigin(context.request, false);
        const body = await readSocialJsonWithSchema(context.request, socialWalletSignInChallengeRequestSchema);
        let address: string;
        try {
          address = canonicalSuiAddress(body.address);
        } catch {
          throw new SocialRouteError("invalid_request");
        }
        let issued;
        try {
          issued = await challenges.issue(
            { action: "sign_in", address, origin: expectedOrigin, context: { kind: "attempt", id: createAttemptId() } },
            { ip: context.client.rateKey, address },
          );
        } catch (error) {
          throw challengeRefusal(error, "invalid_request");
        }
        metric("challenge", "issued");
        const response: SocialWalletChallengeResponse = {
          challenge_id: issued.challengeId,
          message: issued.message,
          expires_at_ms: Date.parse(issued.expiresAt),
        };
        return context.json(response);
      }),
    }),
    session: Object.freeze({
      POST: kit.route({ name: SOCIAL_WALLET_SESSION_CREATE_ROUTE, auth: "none", bucket: "social_wallet_sign_in" }, async (context) => {
        requireOrigin(context.request, true);
        const proof = await readProof(context.request);
        let verified;
        try {
          verified = await challenges.verify(
            {
              action: "sign_in",
              address: proof.address,
              origin: expectedOrigin,
              context: { kind: "attempt", id: proof.attemptId },
              challengeId: proof.challengeId,
              message: proof.message,
              signature: proof.signature,
            },
            { ip: context.client.rateKey, address: proof.address },
          );
        } catch (error) {
          const refusal = challengeRefusal(error, "wallet_proof_invalid");
          if (refusal instanceof SocialRouteError && refusal.code === "wallet_proof_invalid") metric("session", "proof_invalid");
          throw refusal;
        }
        const token = createToken();
        const session = await context.transaction(
          (social) =>
            createWalletSession(social, { token, address: verified.address, challengeId: verified.challengeId, now: clock() }),
          { label: "social.wallet_session_create" },
        );
        metric("session", "created");
        const body: SocialWalletSessionResponse = { expires_at_ms: session.expiresAt.getTime() };
        return headersWithCookies(
          context.json(body, 201),
          walletSessionCookies(token, Math.floor(SOCIAL_WALLET_SESSION_TTL_MS / 1_000)),
        );
      }),
      DELETE: kit.route({ name: SOCIAL_WALLET_SESSION_DELETE_ROUTE, auth: "none", bucket: "social_wallet_sign_in" }, async (context) => {
        requireOrigin(context.request, true);
        if ((await readSocialBody(context.request)).byteLength > 0) throw new SocialRouteError("invalid_request");
        const token = readWalletSessionToken(context.request);
        if (token) {
          const revoked = await context.transaction((social) => revokeWalletSession(social, token, clock()), {
            label: "social.wallet_session_revoke",
          });
          metric("sign_out", revoked ? "revoked" : "no_session");
        }
        const body: SocialWalletSignOutResponse = { signed_in: false };
        return headersWithCookies(context.json(body), clearedWalletSessionCookies());
      }),
    }),
  });
}

/**
 * A wallet challenge refusal as a social one: too many attempts for this IP
 * and address is `rate_limited` (with its Retry-After), an outage passes
 * through (503), anything else is `invalid`.
 */
function challengeRefusal(error: unknown, invalid: "invalid_request" | "wallet_proof_invalid"): unknown {
  if (!(error instanceof WalletChallengeError)) return error;
  if (error.code === "WALLET_CHALLENGE_RATE_LIMITED") {
    return new SocialRouteError("rate_limited", { retryAfterSeconds: error.retryAfterSeconds });
  }
  if (error.code === "WALLET_PROOF_UNAVAILABLE") return error;
  return new SocialRouteError(invalid);
}

type Proof = Readonly<{ challengeId: string; address: string; attemptId: string; message: string; signature: string }>;

/**
 * The closed proof body (at most 12 KiB). The attempt id is read back from
 * the message: the challenge's stored hash binds the whole text, so a changed
 * line fails verification anyway.
 */
async function readProof(request: Request): Promise<Proof> {
  const { challenge_id: challengeId, address, message, signature } =
    await readSocialJsonWithSchema(request, socialWalletSessionRequestSchema, SESSION_BODY_LIMIT_BYTES);
  let canonical: string;
  try {
    canonical = canonicalSuiAddress(address);
  } catch {
    throw new SocialRouteError("invalid_request");
  }
  const attemptId = ATTEMPT_LINE.exec(message)?.[1];
  if (!attemptId) throw new SocialRouteError("wallet_proof_invalid");
  return { challengeId, address: canonical, attemptId, message, signature };
}
