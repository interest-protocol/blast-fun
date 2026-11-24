import { z } from "zod";
import { randomUUID } from "node:crypto";

import { recordPresaleMetric } from "../redaction/redaction.ts";
import type { PrivyAccessClaims } from "@blast/core/lib/privy-adapter/types.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { readWalletSessionToken } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import {
  DEFAULT_RATE_POLICIES,
  type PresaleRateBucket,
  type RateLimitDecision,
  type RateLimitPort,
  type RateLimitSubject,
} from "@blast/core/lib/web-security/rate-limits.ts";
import type { PresaleErrorCode } from "../contracts/errors.ts";
import { PRESALE_ROUTES } from "../contracts/routes.ts";
import type { PresaleRuntimeIdentity } from "../deployment/contracts.ts";
import type { PresaleDeploymentGate } from "../deployment/service.ts";
import type { AgentApiKeyVerifier, PresalePrincipal, PresaleRouteSpec } from "./contracts.ts";
import { PresaleRouteError, presaleErrorCause, toPresaleRouteError } from "./errors.ts";

/** The header an AI agent sends its API key in, on `account_or_api_key` routes. */
const PRESALE_API_KEY_HEADER = "x-blast-api-key";
/** The default request body cap. */
const PRESALE_BODY_LIMIT_BYTES = 64 * 1_024;
const BEARER = /^Bearer ([^\s]{1,8192})$/;

export interface PresaleRouteKitDependencies {
  /** The site origin: a present `Origin` header must equal it. */
  expectedOrigin: string;
  /** `createPrivyTokenVerifier`: local ES256 verification, no provider call. */
  verifyAccessToken(accessToken: string): Promise<PrivyAccessClaims>;
  /** Agent API keys (`X-Blast-Api-Key`); without it every key is `unauthorized`. */
  verifyApiKey?: AgentApiKeyVerifier;
  /**
   * Counts every API key lookup per client IP (`presale_api_key_ip`) before
   * `verifyApiKey` reads the database. In memory, per instance: production
   * passes `instanceRouteLimiter()`; the default is this kit's own.
   */
  apiKeyLimiter?: RateLimitPort;
  /**
   * Outside-wallet sign-in sessions (the `__Host-blast_wallet` cookie), read
   * on `account_or_wallet` routes only; without it those routes take Privy
   * tokens alone.
   */
  walletSessions?: Readonly<{ live(token: string): Promise<Readonly<{ address: string }> | null> }>;
  /**
   * Failed wallet-session lookups per client IP (`social_auth_failure`), in
   * memory: once full, no cookie is looked up. Production passes
   * `instanceRouteLimiter()`; the default is this kit's own.
   */
  authFailures?: Pick<MemoryRateLimiter, "peek" | "consume">;
  limiter: RateLimitPort;
  deployment: PresaleDeploymentGate;
  createRequestId?: () => string;
}

export type PresaleRequestContext = Readonly<{
  request: Request;
  requestId: string;
  client: ClientAddress;
  principal: PresalePrincipal | null;
  /** The Privy account, when the principal is one. */
  account: Readonly<{ did: string }> | null;
  /** The outside wallet, when the principal is a wallet session. */
  wallet: Readonly<{ address: string }> | null;
  /** Present when the spec asks for `deployment: "verified"`. */
  deployment: PresaleRuntimeIdentity | null;
  /** A success response with the kit's headers. */
  json(body: unknown, status?: number): Response;
  /** Counts one more request in `bucket` for this caller, for a route-level budget. */
  consume(bucket: PresaleRateBucket): Promise<RateLimitDecision>;
}>;

export type PresaleRouteHandler = (context: PresaleRequestContext) => Promise<Response>;

function headers(requestId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "Cache-Control": "no-store", "X-Request-ID": requestId, ...extra };
}

function presaleJson(requestId: string, body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: headers(requestId) });
}

/** `{ error: { code, message, ...extra } }` with `Retry-After` exactly when the code carries it (CL-23). */
export function presaleErrorResponse(requestId: string, error: PresaleRouteError): Response {
  return Response.json(error.body(), {
    status: error.status,
    headers: headers(
      requestId,
      error.retryAfterSeconds === null ? {} : { "Retry-After": String(error.retryAfterSeconds) },
    ),
  });
}

function canonicalOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (origin === "null") throw new TypeError("The expected origin must be an http(s) origin.");
  return origin;
}

/** Refuses a spec whose behaviour would answer a code its published route does not list. */
function assertSpec(spec: PresaleRouteSpec): void {
  const errors: readonly PresaleErrorCode[] = PRESALE_ROUTES[spec.name].errors;
  const needs = (code: PresaleErrorCode, why: string) => {
    if (!errors.includes(code))
      throw new TypeError(`${spec.name} ${why} but does not publish ${code}.`);
  };
  if (spec.auth === "account" || spec.auth === "account_or_api_key" || spec.auth === "account_or_wallet")
    needs("unauthorized", "requires sign-in");
  if (spec.deployment === "verified") {
    needs("deployment_unavailable", "needs the deployment identity");
    needs("deployment_mismatch", "needs the deployment identity");
  }
  for (const bucket of specBuckets(spec)) {
    needs("rate_limited", "is rate limited");
    const scope = DEFAULT_RATE_POLICIES[bucket].subjectScope;
    const signedIn =
      spec.auth === "account" ||
      spec.auth === "account_or_wallet" ||
      (spec.auth === "account_or_api_key" && scope === "account_or_api_key");
    if ((scope === "account" || scope === "account_or_api_key") && !signedIn) {
      throw new TypeError(`${bucket} counts per account, so ${spec.name} must require one.`);
    }
  }
}

function specBuckets(spec: PresaleRouteSpec): readonly PresaleRateBucket[] {
  if (spec.bucket === undefined) return [];
  return typeof spec.bucket === "string" ? [spec.bucket] : spec.bucket;
}

/**
 * The presale web routes' shared kit. Each request, in order:
 *
 * 1. Origin: a present `Origin` other than the site's is `origin_invalid`,
 *    unless the request carries an agent API key (`X-Blast-Api-Key`) on a
 *    route that takes one. Neither credential is ambient, so no CSRF cookie
 *    is needed.
 * 2. Auth: `Authorization: Bearer <Privy access token>` gives the DID; on an
 *    `account_or_api_key` route a present `X-Blast-Api-Key` is the
 *    credential instead, and an unknown or revoked key is `unauthorized`.
 *    On an `account_or_wallet` route a request without a token may sign in
 *    with the outside-wallet session cookie instead: same-origin only
 *    (`Origin` equal to the site and `Sec-Fetch-Site`, when sent,
 *    `same-origin`), and an IP whose cookies keep failing stops being looked
 *    up (`social_auth_failure`). Its rate subject is `sui:<address>`.
 *    The key's lookup is counted per client IP first (`presale_api_key_ip`,
 *    in memory): a forged key of the right shape passes the API gate, so
 *    without it each guess would be a free read of the primary.
 * 3. Rate limit: the spec's buckets in order, per account, API key, client
 *    IP or platform-wide (`global`).
 * 4. Deployment: the identity, checked against the node.
 * 5. The handler.
 *
 * Every answer has `Cache-Control: no-store` and `X-Request-ID`. A failure is
 * mapped to the route's published codes only: anything else the route does
 * not list becomes `service_unavailable`, and no cause reaches the body.
 */
export function createPresaleRouteKit(dependencies: PresaleRouteKitDependencies) {
  const expectedOrigin = canonicalOrigin(dependencies.expectedOrigin);
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  const apiKeyLimiter = dependencies.apiKeyLimiter ?? new MemoryRateLimiter();
  const authFailures = dependencies.authFailures ?? new MemoryRateLimiter();

  async function privyAccount(token: string | null): Promise<PresalePrincipal> {
    if (!token) throw new PresaleRouteError("unauthorized");
    const claims = await dependencies.verifyAccessToken(token);
    return { kind: "account", did: claims.userId };
  }

  /**
   * The caller. An `X-Blast-Api-Key` on an `account_or_api_key` route is
   * settled first and skips the Origin rule: only an agent may call from
   * another origin. Every other request passes the Origin rule, then auth.
   */
  async function authenticate(
    spec: PresaleRouteSpec,
    request: Request,
    client: ClientAddress,
  ): Promise<PresalePrincipal | null> {
    const apiKey =
      spec.auth === "account_or_api_key" ? request.headers.get(PRESALE_API_KEY_HEADER) : null;
    if (apiKey !== null) {
      return agentPrincipal(apiKey, client);
    }
    const token =
      spec.auth === "none"
        ? null
        : (request.headers.get("authorization")?.match(BEARER)?.[1] ?? null);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== expectedOrigin) throw new PresaleRouteError("origin_invalid");
    if (spec.auth === "none") return null;
    if (spec.auth === "optional") {
      try {
        return token ? await privyAccount(token) : null;
      } catch {
        return null;
      }
    }
    // A Privy session wins over a wallet session the browser also holds.
    if (spec.auth === "account_or_wallet" && token === null) return walletPrincipal(request, client);
    return privyAccount(token);
  }

  async function walletPrincipal(request: Request, client: ClientAddress): Promise<PresalePrincipal> {
    const cookie = dependencies.walletSessions ? readWalletSessionToken(request) : null;
    if (!cookie) throw new PresaleRouteError("unauthorized");
    // The cookie is ambient: only the site's own fetches may use it (it is also SameSite=Strict).
    const site = request.headers.get("sec-fetch-site");
    if (request.headers.get("origin") !== expectedOrigin || (site !== null && site !== "same-origin"))
      throw new PresaleRouteError("origin_invalid");
    const failures = { ip: client.rateKey };
    const room = await authFailures.peek("social_auth_failure", failures);
    if (!room.allowed)
      throw new PresaleRouteError("rate_limited", { retryAfterSeconds: room.retryAfterSeconds });
    const session = await dependencies.walletSessions!.live(cookie);
    if (!session) {
      await authFailures.consume("social_auth_failure", failures);
      throw new PresaleRouteError("unauthorized");
    }
    return { kind: "wallet", address: session.address, did: null };
  }

  async function agentPrincipal(apiKey: string, client: ClientAddress): Promise<PresalePrincipal> {
    // Review M2: count the lookup per client IP before it reads the database.
    const attempt = await apiKeyLimiter.consume("presale_api_key_ip", { ip: client.rateKey });
    if (!attempt.allowed)
      throw new PresaleRouteError("rate_limited", { retryAfterSeconds: attempt.retryAfterSeconds });
    // The header is the credential: an unknown or revoked key never falls back to Privy.
    const key = dependencies.verifyApiKey ? await dependencies.verifyApiKey(apiKey) : null;
    if (!key) throw new PresaleRouteError("unauthorized");
    return { kind: "api_key", keyId: key.keyId, did: key.did };
  }

  function subject(principal: PresalePrincipal | null, ip: string): RateLimitSubject {
    if (principal?.kind === "account") return { accountId: principal.did, ip };
    if (principal?.kind === "wallet") return { accountId: `sui:${principal.address}`, ip };
    if (principal?.kind === "api_key") {
      return principal.did
        ? { accountId: principal.did, apiKeyId: principal.keyId, ip }
        : { apiKeyId: principal.keyId, ip };
    }
    return { ip };
  }

  return Object.freeze({
    route(
      spec: PresaleRouteSpec,
      handler: PresaleRouteHandler,
    ): (request: Request, client: ClientAddress) => Promise<Response> {
      assertSpec(spec);
      const buckets = specBuckets(spec);
      const published: readonly PresaleErrorCode[] = PRESALE_ROUTES[spec.name].errors;
      return async (request, client) => {
        const requestId = createRequestId();
        try {
          const principal = await authenticate(spec, request, client);
          const consume = (bucket: PresaleRateBucket) =>
            dependencies.limiter.consume(bucket, subject(principal, client.rateKey));
          for (const bucket of buckets) {
            const decision = await consume(bucket);
            if (!decision.allowed) {
              throw new PresaleRouteError("rate_limited", {
                retryAfterSeconds: decision.retryAfterSeconds,
              });
            }
          }
          const deployment =
            spec.deployment === "verified"
              ? await dependencies.deployment.authorize({ signal: request.signal })
              : null;
          return await handler(
            Object.freeze({
              request,
              requestId,
              client,
              principal,
              account: principal?.did ? { did: principal.did } : null,
              wallet: principal?.kind === "wallet" ? { address: principal.address } : null,
              deployment,
              json: (body: unknown, status = 200) => presaleJson(requestId, body, status),
              consume,
            }),
          );
        } catch (caught) {
          let error = toPresaleRouteError(caught);
          if (!published.includes(error.code)) {
            recordPresaleMetric("presale.route", {
              route: spec.name,
              requestId,
              outcome: "undeclared_code",
              code: error.code,
            });
            error = new PresaleRouteError("service_unavailable");
          }
          if (error.status >= 500 || request.method !== "GET") {
            recordPresaleMetric("presale.route", {
              route: spec.name,
              requestId,
              status: error.status,
              outcome: error.status >= 500 ? "error" : "refused",
              code: error.code,
              cause: presaleErrorCause(caught),
            });
          }
          return presaleErrorResponse(requestId, error);
        }
      };
    },
  });
}

export type PresaleRouteKit = ReturnType<typeof createPresaleRouteKit>;

/**
 * Reads at most `maxBytes` of a request body. A declared `Content-Length`
 * over the limit is refused unread; a streamed body that passes it is
 * cancelled. Both are `tooLarge` (default `body_too_large`).
 */
export async function readBoundedBody(
  request: Request,
  options: Readonly<{ maxBytes: number; tooLarge?: "body_too_large" | "allowlist_too_large" }>,
): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = options.tooLarge ?? "body_too_large";
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > options.maxBytes)
    throw new PresaleRouteError(tooLarge);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PresaleRouteError(tooLarge);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Reads a JSON request body of at most `maxBytes` (default 64 KiB). Another
 * content type, invalid UTF-8 or invalid JSON is `invalid_request`; a larger
 * body, declared or streamed, is `body_too_large`.
 */
export async function readJsonBody(
  request: Request,
  options: Readonly<{ maxBytes?: number }> = {},
): Promise<unknown> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") throw new PresaleRouteError("invalid_request");
  const body = await readBoundedBody(request, {
    maxBytes: options.maxBytes ?? PRESALE_BODY_LIMIT_BYTES,
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new PresaleRouteError("invalid_request");
  }
}

/** The body as an object with exactly `required` keys plus any of `optional`, else `invalid_request`. */
export function exactKeys<const Required extends string, const Optional extends string = never>(
  value: unknown,
  required: readonly Required[],
  optional: readonly Optional[] = [],
): Record<Required, unknown> & Partial<Record<Optional, unknown>> {
  const shape = Object.fromEntries(
    [...required, ...optional].map((key) => [key, z.unknown().optional()]),
  );
  const parsed = z
    .strictObject(shape)
    .refine((record) => required.every((key) => Object.hasOwn(record, key)))
    .safeParse(value);
  if (!parsed.success) throw new PresaleRouteError("invalid_request");
  return parsed.data as Record<Required, unknown> & Partial<Record<Optional, unknown>>;
}
