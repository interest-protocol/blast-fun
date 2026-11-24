import { isLoopbackHostname } from "@blast/core/lib/loopback.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { Pool } from "pg";

import type {
  PrivyOnboardingAdapter,
  PrivyOnboardingProof,
} from "@blast/core/lib/privy-adapter/types.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import type { AdaptiveChallengeController } from "@blast/server/lib/web-security/adaptive-challenge.ts";
import { WebSecurityError, webSecurityErrorResponse } from "@blast/core/lib/web-security/errors.ts";
import type {
  RateLimitPort,
  RateLimitSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";

export const X_OAUTH_COOKIE_NAME = "__Host-blast_x_oauth";
export const X_OAUTH_TTL_MS = 10 * 60 * 1_000;

export interface XOAuthProvider {
  authorizationOrigin: string;
  createAuthorizationUrl(input: {
    callbackUrl: string;
    codeChallenge: string;
    nonce: string;
    state: string;
  }): Promise<string> | string;
  exchangeCode(input: {
    callbackUrl: string;
    code: string;
    codeVerifier: string;
  }): Promise<{ accessToken: string; nonce: string }>;
}

interface OAuthStateRecord {
  stateHash: string;
  nonceHash: string;
  pkceVerifierHash: string;
  origin: string;
  callbackUrl: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface OAuthStateStore {
  create(record: OAuthStateRecord): Promise<void>;
  consume(input: {
    state: string;
    nonce: string;
    pkceVerifier: string;
    origin: string;
    callbackUrl: string;
    now: Date;
  }): Promise<boolean>;
}

export class PostgresOAuthStateStore implements OAuthStateStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(record: OAuthStateRecord): Promise<void> {
    await withTransaction(this.#pool, async (transaction) => {
      await transaction.forModule("web-security").write(
        "mission_control_oauth_states",
        `INSERT INTO mission_control_oauth_states (
           state_hash, nonce_hash, pkce_verifier_hash, origin, callback_url,
           issued_at, expires_at, consumed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
        [
          record.stateHash,
          record.nonceHash,
          record.pkceVerifierHash,
          record.origin,
          record.callbackUrl,
          record.issuedAt,
          record.expiresAt,
        ],
      );
    });
  }

  async consume(input: {
    state: string;
    nonce: string;
    pkceVerifier: string;
    origin: string;
    callbackUrl: string;
    now: Date;
  }): Promise<boolean> {
    return withTransaction(this.#pool, async (transaction) => {
      const result = await transaction.forModule("web-security").write(
        "mission_control_oauth_states",
        `UPDATE mission_control_oauth_states
         SET consumed_at = $6
         WHERE state_hash = $1
           AND nonce_hash = $2
           AND pkce_verifier_hash = $3
           AND origin = $4
           AND callback_url = $5
           AND consumed_at IS NULL
           AND expires_at > $6
         RETURNING state_hash`,
        [
          sha256(input.state),
          sha256(input.nonce),
          sha256(input.pkceVerifier),
          input.origin,
          input.callbackUrl,
          input.now,
        ],
      );
      return result.rowCount === 1;
    });
  }
}

interface OAuthCookiePayload {
  state: string;
  nonce: string;
  verifier: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function cookieValue(payload: OAuthCookiePayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function parseCookiePayload(value: string | null): OAuthCookiePayload {
  try {
    if (!value || value.length > 2_048) throw new Error("missing");
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid");
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.state !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.state) ||
      typeof record.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.nonce) ||
      typeof record.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(record.verifier)
    ) {
      throw new Error("invalid");
    }
    return {
      state: record.state,
      nonce: record.nonce,
      verifier: record.verifier,
    };
  } catch {
    throw new WebSecurityError("OAUTH_STATE_INVALID");
  }
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function setOAuthCookie(payload: OAuthCookiePayload): string {
  return `${X_OAUTH_COOKIE_NAME}=${cookieValue(payload)}; Path=/; Max-Age=${X_OAUTH_TTL_MS / 1_000}; HttpOnly; Secure; SameSite=Lax`;
}

function clearOAuthCookie(): string {
  return `${X_OAUTH_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function canonicalOrigin(value: string): string {
  try {
    const url = new URL(value);
    const loopback = isLoopbackHostname(url.hostname);
    if (
      url.origin !== value ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    ) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw new WebSecurityError("OAUTH_CONFIGURATION_INVALID");
  }
}

function exactCallbackUrl(value: string, origin: string): string {
  try {
    const url = new URL(value);
    if (
      url.origin !== origin ||
      url.href !== value ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith("/callback")
    ) {
      throw new Error("invalid");
    }
    return url.href;
  } catch {
    throw new WebSecurityError("OAUTH_CONFIGURATION_INVALID");
  }
}

function boundedQuery(value: string | null, maximum: number): string {
  if (!value || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new WebSecurityError("OAUTH_STATE_INVALID");
  }
  return value;
}

export interface XOAuthRouteDependencies {
  origin: string;
  callbackUrl: string;
  provider: XOAuthProvider;
  privyAdapter: PrivyOnboardingAdapter;
  stateStore: OAuthStateStore;
  limiter: RateLimitPort;
  adaptiveChallenge: AdaptiveChallengeController;
  rateSubject(request: Request): RateLimitSubject;
  riskSignal(request: Request): {
    recentFailures: number;
    challengeToken?: string;
  };
  clock?: () => Date;
  tokenFactory?: () => string;
}

export interface XOAuthRouteHandlers {
  start(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
}

async function enforceRequestControls(
  request: Request,
  dependencies: XOAuthRouteDependencies,
): Promise<void> {
  const signal = dependencies.riskSignal(request);
  await dependencies.adaptiveChallenge.enforce({
    bucket: "oauth",
    ...signal,
  });
  const decision = await dependencies.limiter.consume(
    "oauth",
    dependencies.rateSubject(request),
  );
  if (!decision.allowed) throw new WebSecurityError("RATE_LIMITED");
}

export function createXOAuthRouteHandlers(
  dependencies: XOAuthRouteDependencies,
): XOAuthRouteHandlers {
  const origin = canonicalOrigin(dependencies.origin);
  const callbackUrl = exactCallbackUrl(dependencies.callbackUrl, origin);
  const providerOrigin = canonicalOrigin(dependencies.provider.authorizationOrigin);
  const clock = dependencies.clock ?? (() => new Date());
  const tokenFactory = dependencies.tokenFactory ?? randomToken;

  return {
    async start(request) {
      try {
        const requestUrl = new URL(request.url);
        if (requestUrl.origin !== origin || request.method !== "GET") {
          throw new WebSecurityError("ORIGIN_INVALID");
        }
        await enforceRequestControls(request, dependencies);
        const state = tokenFactory();
        const nonce = tokenFactory();
        const verifier = tokenFactory();
        if (
          !/^[A-Za-z0-9_-]{43}$/.test(state) ||
          !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)
        ) {
          throw new WebSecurityError("OAUTH_CONFIGURATION_INVALID");
        }
        const issuedAt = clock();
        const authorizationUrl = new URL(
          await dependencies.provider.createAuthorizationUrl({
            callbackUrl,
            codeChallenge: pkceChallenge(verifier),
            nonce,
            state,
          }),
        );
        if (authorizationUrl.origin !== providerOrigin) {
          throw new WebSecurityError("OAUTH_FAILED");
        }
        await dependencies.stateStore.create({
          callbackUrl,
          expiresAt: new Date(issuedAt.getTime() + X_OAUTH_TTL_MS),
          issuedAt,
          nonceHash: sha256(nonce),
          origin,
          pkceVerifierHash: sha256(verifier),
          stateHash: sha256(state),
        });
        return new Response(null, {
          status: 302,
          headers: {
            "Cache-Control": "no-store",
            Location: authorizationUrl.href,
            "Set-Cookie": setOAuthCookie({ state, nonce, verifier }),
          },
        });
      } catch (error) {
        return webSecurityErrorResponse(error);
      }
    },

    async callback(request) {
      try {
        const requestUrl = new URL(request.url);
        if (
          requestUrl.origin !== origin ||
          `${requestUrl.origin}${requestUrl.pathname}` !== callbackUrl ||
          request.method !== "GET"
        ) {
          throw new WebSecurityError("ORIGIN_INVALID");
        }
        await enforceRequestControls(request, dependencies);
        if (requestUrl.searchParams.has("error")) {
          throw new WebSecurityError("OAUTH_FAILED");
        }
        const state = boundedQuery(requestUrl.searchParams.get("state"), 128);
        const code = boundedQuery(requestUrl.searchParams.get("code"), 2_048);
        const cookie = parseCookiePayload(readCookie(request, X_OAUTH_COOKIE_NAME));
        if (!secureEqual(state, cookie.state)) {
          throw new WebSecurityError("OAUTH_STATE_INVALID");
        }
        if (
          !(await dependencies.stateStore.consume({
            callbackUrl,
            nonce: cookie.nonce,
            now: clock(),
            origin,
            pkceVerifier: cookie.verifier,
            state,
          }))
        ) {
          throw new WebSecurityError("OAUTH_STATE_INVALID");
        }
        const exchange = await dependencies.provider.exchangeCode({
          callbackUrl,
          code,
          codeVerifier: cookie.verifier,
        });
        if (
          !exchange.accessToken ||
          !exchange.nonce ||
          !secureEqual(exchange.nonce, cookie.nonce)
        ) {
          throw new WebSecurityError("OAUTH_STATE_INVALID");
        }
        let proof: PrivyOnboardingProof;
        try {
          proof = await dependencies.privyAdapter.verifyXIdentityAndResolveWallet(
            exchange.accessToken,
          );
        } catch (error) {
          if (error instanceof PrivyAdapterError && ["ACCESS_TOKEN_EXPIRED", "INVALID_ACCESS_TOKEN", "IDENTITY_NOT_FOUND"].includes(error.code)) throw new WebSecurityError("OAUTH_FAILED");
          throw new WebSecurityError("OAUTH_UNAVAILABLE");
        }
        return Response.json(
          { proof },
          {
            status: 200,
            headers: {
              "Cache-Control": "no-store",
              "Set-Cookie": clearOAuthCookie(),
            },
          },
        );
      } catch (error) {
        const response = webSecurityErrorResponse(error);
        response.headers.append("Set-Cookie", clearOAuthCookie());
        return response;
      }
    },
  };
}
