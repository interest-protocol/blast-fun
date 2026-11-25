import { z } from "zod";

import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { recordMetric, observeMetric } from "@blast/core/lib/metrics.ts";
import type { PrivyAccessClaims } from "@blast/core/lib/privy-adapter/types.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { MemoryRateLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import {
  DEFAULT_RATE_POLICIES,
  type RateLimitPort,
  type RateLimitSubject,
  type SocialRateBucket,
} from "@blast/core/lib/web-security/rate-limits.ts";
import {
  withTransaction,
  type ModuleTransaction,
  type TransactionContext,
  type TransactionOptions,
} from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_FEED_TRADE_KINDS } from "@blast/core/modules/social/contracts/feed.ts";
import type { SocialAccount } from "@blast/core/modules/social/contracts/me.ts";
import { clearedWalletSessionCookies, readWalletSessionToken } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import type { SocialAccountLoader, SocialRouteSpec } from "./contracts.ts";
import { SocialRouteError, socialErrorCause, toSocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { socialInput } from "./validation.ts";

/** Social request bodies are at most 4 KiB. */
export const SOCIAL_BODY_LIMIT_BYTES = 4 * 1_024;
const BEARER = /^Bearer ([^\s]{1,8192})$/;
const NO_STORE = "no-store";
const PRIVATE_NO_STORE = "private, no-store";
/** A public social read's success: the CDN serves it 10 s and revalidates in the background for 20 s more. */
export const SOCIAL_PUBLIC_CACHE_CONTROL = "public, s-maxage=10, stale-while-revalidate=20";
/**
 * A public read its owner can withdraw (the opt-in portfolio, OA-30): the CDN
 * serves a success 10 s and never stale, so a portfolio made private stops
 * answering from the edge within 10 s.
 */
export const SOCIAL_PUBLIC_FRESH_CACHE_CONTROL = "public, s-maxage=10";
/**
 * A public read of a settled fact (one trade's buy card): the CDN serves a
 * success 5 minutes, so a privacy change still reaches the edge within 5
 * minutes.
 */
export const SOCIAL_PUBLIC_SETTLED_CACHE_CONTROL = "public, s-maxage=300";
const SHARED_CACHE_CONTROL = {
  public: SOCIAL_PUBLIC_CACHE_CONTROL,
  "public-fresh": SOCIAL_PUBLIC_FRESH_CACHE_CONTROL,
  "public-settled": SOCIAL_PUBLIC_SETTLED_CACHE_CONTROL,
} as const;

export interface SocialRouteKitDependencies {
  /** The site origin: a present `Origin` header must equal it. */
  expectedOrigin: string;
  /** `createPrivyTokenVerifier`: local ES256 verification, no provider call. */
  verifyAccessToken(accessToken: string): Promise<PrivyAccessClaims>;
  limiter: RateLimitPort;
  /** Resolves the caller's Blast Account on the primary. */
  accounts: SocialAccountLoader;
  /**
   * The live wallet session a `__Host-blast_wallet` cookie names (Slush
   * sign-in, OA-16), or null. Without it the cookie is never read.
   */
  walletSessions?: Readonly<{ live(token: string): Promise<Readonly<{ address: string }> | null> }>;
  /**
   * Wallet session cookies that named no live session, per client IP
   * (`social_auth_failure`, review L4): read before each session lookup,
   * counted after a failed one. In memory, per instance: production passes
   * `instanceRouteLimiter()`; the default is this kit's own.
   */
  authFailures?: Pick<MemoryRateLimiter, "peek" | "consume">;
  /** The primary pool, for the kit's write transactions. Resolved per call, never at construction. */
  primary: () => Pool;
  createRequestId?: () => string;
  /**
   * The share (0–1) of answered requests below 500 that record a
   * `social.route` duration metric; every 5xx is recorded. Default
   * `SOCIAL_ROUTE_METRIC_SAMPLE_RATE`.
   */
  metricSampleRate?: number;
  /** Uniform [0, 1); tests pin it. */
  random?: () => number;
  /** Read once per request into `trading` and `hiddenKinds`. */
  tradingVisible: (request: Request) => boolean;
}

/**
 * The verified caller: a Privy session (X, Google, EVM or Solana wallets
 * through Privy; a Bearer access token) or a Sui wallet session (Slush; the
 * HttpOnly cookie, OA-16). `subject` keys the caller's rate limits:
 * the Privy DID, or `sui:<address>`. Neither ever leaves the server.
 */
export type SocialCaller =
  | Readonly<{ kind: "privy"; did: string; subject: string }>
  | Readonly<{ kind: "wallet"; address: string; subject: string }>;

/**
 * Whether a cookie-authenticated request is the site's own: `Sec-Fetch-Site`,
 * when sent, is `same-origin`; and `Origin` equals the site, or (browsers send
 * no `Origin` on a same-origin GET) a GET or HEAD says `Sec-Fetch-Site:
 * same-origin`. The session cookie is also `SameSite=Strict`.
 */
export function isSameOriginRequest(request: Request, expectedOrigin: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === expectedOrigin;
  return (request.method === "GET" || request.method === "HEAD") && site === "same-origin";
}

function withClearedWalletCookies(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", PRIVATE_NO_STORE);
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Vercel-CDN-Cache-Control", "no-store");
  for (const cookie of clearedWalletSessionCookies()) headers.append("Set-Cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

/** Default share of answered social requests that record their duration (5xx always do). */
export const SOCIAL_ROUTE_METRIC_SAMPLE_RATE = 0.1;

export type SocialRequestContext = Readonly<{
  request: Request;
  requestId: string;
  client: ClientAddress;
  /** The verified caller (Privy or wallet session). Its DID or address never leaves the server. */
  caller: SocialCaller | null;
  /** The caller's Blast Account when the spec loads it (`resolve` or `required`), else null. */
  account: SocialAccount | null;
  /** Trading surfaces show for this request (`tradingVisible`, resolved once). */
  trading: boolean;
  /** Activity kinds reads leave out: none while `trading`, else the trade kinds. */
  hiddenKinds: readonly string[];
  /** A success response with the route's headers. */
  json(body: unknown, status?: number): Response;
  /** Counts one more request in `bucket` for this caller; a full bucket throws `rate_limited`. */
  consume(bucket: SocialRateBucket): Promise<void>;
  /** Counts using the resolved stable Blast Account; without one throws `account_required`. */
  consumeAccount(bucket: SocialRateBucket): Promise<void>;
  /** Runs on the primary; other owning modules can join the same atomic transaction. */
  transaction<Result>(
    operation: (
      social: ModuleTransaction<"social">,
      transaction: TransactionContext,
    ) => Promise<Result>,
    options?: TransactionOptions,
  ): Promise<Result>;
}>;

export type SocialRouteHandler = (context: SocialRequestContext) => Promise<Response>;

function headers(requestId: string, cacheControl: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "Cache-Control": cacheControl, "X-Request-ID": requestId, ...extra };
}

/** A success answer: `Cache-Control` (default `no-store`) and `X-Request-ID`. */
export function socialJson(requestId: string, body: unknown, status = 200, cacheControl = NO_STORE): Response {
  return Response.json(body, { status, headers: headers(requestId, cacheControl) });
}

/** `{ error: { code, message, ...extra } }` with `Retry-After` exactly when the code carries it. */
export function socialErrorResponse(requestId: string, error: SocialRouteError, cacheControl = NO_STORE): Response {
  return Response.json(error.body(), {
    status: error.status,
    headers: headers(
      requestId,
      cacheControl,
      error.retryAfterSeconds === null ? {} : { "Retry-After": String(error.retryAfterSeconds) },
    ),
  });
}

function canonicalOrigin(value: string): string {
  const origin = new URL(value).origin;
  if (origin === "null") throw new TypeError("The expected origin must be an http(s) origin.");
  return origin;
}

/** Refuses a spec that could not keep its promises: an account or account bucket without sign-in. */
function assertSpec(spec: SocialRouteSpec): void {
  const account = spec.account ?? "none";
  if (account !== "none" && spec.auth === "none") {
    throw new TypeError(`${spec.name} loads an account, so it must read the caller.`);
  }
  if (spec.cache !== undefined && spec.cache in SHARED_CACHE_CONTROL && spec.auth !== "none") {
    throw new TypeError(`${spec.name} is publicly cached, so it must not read the caller.`);
  }
  if (spec.bucket) {
    const scope = DEFAULT_RATE_POLICIES[spec.bucket].subjectScope;
    if (scope !== "ip" && spec.auth !== "account") {
      throw new TypeError(`${spec.bucket} counts per account, so ${spec.name} must require one.`);
    }
  }
}

function visibility(trading: boolean): Pick<SocialRequestContext, "trading" | "hiddenKinds"> {
  return { trading, hiddenKinds: trading ? [] : SOCIAL_FEED_TRADE_KINDS };
}

/**
 * The social routes' shared kit. Each request, in order:
 *
 * 1. Origin: a present `Origin` other than the site's is `origin_invalid`.
 * 2. Auth: `Authorization: Bearer <Privy access token>`, verified locally;
 *    without one, the wallet session cookie (OA-16), only on a same-origin
 *    request (`isSameOriginRequest`; else `origin_invalid`, or anonymous on
 *    an `optional` route). A cookie whose session is gone is cleared, and
 *    counts per client IP (`social_auth_failure`); once that is full, no
 *    cookie from the IP is looked up until the window ends (`rate_limited`,
 *    or anonymous on an `optional` route).
 * 3. Rate limit: the spec's bucket, per caller (Privy DID or `sui:<address>`)
 *    or client IP.
 * 4. Account: the caller's Blast Account on the primary, when the spec asks;
 *    `required` refuses a caller without one (`account_required`).
 * 5. Visibility: `tradingVisible`, read once, gives `trading` and `hiddenKinds`.
 * 6. The handler.
 *
 * Every answer has `Cache-Control` (`no-store`, or `private, no-store` for a
 * `private` route, or `SOCIAL_PUBLIC_CACHE_CONTROL` for a `public` route's
 * 200, `SOCIAL_PUBLIC_FRESH_CACHE_CONTROL` for a `public-fresh` one's,
 * `SOCIAL_PUBLIC_SETTLED_CACHE_CONTROL` for a `public-settled` one's) and
 * `X-Request-ID`; 429 and 503 carry `Retry-After`. A
 * failure maps to a published code and no cause reaches the body or a log
 * line: metrics carry the route, the code and a value-free cause label only.
 * Every 5xx records a `social.route` metric; a sampled share of the other
 * answers (`metricSampleRate`) records its status and duration.
 */
export function createSocialRouteKit(dependencies: SocialRouteKitDependencies) {
  const expectedOrigin = canonicalOrigin(dependencies.expectedOrigin);
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  const sampleRate = Math.min(Math.max(dependencies.metricSampleRate ?? SOCIAL_ROUTE_METRIC_SAMPLE_RATE, 0), 1);
  const random = dependencies.random ?? Math.random;
  const authFailures = dependencies.authFailures ?? new MemoryRateLimiter();

  /** One `social.route` line per sampled answer below 500: the route, its status and how long it took (never a value). */
  function recordAnswer(name: string, requestId: string, status: number, started: number): void {
    if (sampleRate <= 0 || random() >= sampleRate) return;
    recordMetric("social.route", {
      route: name,
      requestId,
      status,
      outcome: status < 400 ? "ok" : "refused",
      durationMs: Math.round(performance.now() - started),
      ...(sampleRate < 1 ? { sampleRate } : {}),
    });
  }

  type Authenticated = Readonly<{ caller: SocialCaller | null; clearWallet: boolean }>;

  async function authenticate(spec: SocialRouteSpec, request: Request, client: ClientAddress): Promise<Authenticated> {
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== expectedOrigin) throw new SocialRouteError("origin_invalid");
    if (spec.auth === "none") return { caller: null, clearWallet: false };
    const optional = spec.auth === "optional";
    const token = request.headers.get("authorization")?.match(BEARER)?.[1] ?? null;
    if (token) {
      // A Privy session wins over a wallet session the browser also holds.
      try {
        const did = (await dependencies.verifyAccessToken(token)).userId;
        return { caller: { kind: "privy", did, subject: did }, clearWallet: false };
      } catch (error) {
        if (optional) {
          observeMetric("social.auth", { outcome: "anonymous", cause: toSocialRouteError(error).code });
          return { caller: null, clearWallet: false };
        }
        throw error;
      }
    }
    return authenticateWallet(request, client, optional);
  }

  async function authenticateWallet(request: Request, client: ClientAddress, optional: boolean): Promise<Authenticated> {
    const cookie = dependencies.walletSessions ? readWalletSessionToken(request) : null;
    if (!cookie) {
      if (optional) return { caller: null, clearWallet: false };
      throw new SocialRouteError("unauthorized");
    }
    if (!isSameOriginRequest(request, expectedOrigin)) {
      if (optional) return { caller: null, clearWallet: false };
      throw new SocialRouteError("origin_invalid");
    }
    // Review L4: a cookie costs a lookup on the primary, so an IP whose cookies keep failing stops getting them.
    const failures = { ip: client.rateKey };
    const room = await authFailures.peek("social_auth_failure", failures);
    if (!room.allowed) {
      if (optional) return { caller: null, clearWallet: false };
      throw new SocialRouteError("rate_limited", { retryAfterSeconds: room.retryAfterSeconds });
    }
    const session = await dependencies.walletSessions!.live(cookie);
    if (!session) {
      await authFailures.consume("social_auth_failure", failures);
      if (optional) return { caller: null, clearWallet: true };
      throw Object.assign(new SocialRouteError("unauthorized"), { clearWallet: true });
    }
    return { caller: { kind: "wallet", address: session.address, subject: `sui:${session.address}` }, clearWallet: false };
  }

  async function consume(bucket: SocialRateBucket, caller: SocialCaller | null, ip: string, accountId = caller?.subject): Promise<void> {
    const scope = DEFAULT_RATE_POLICIES[bucket].subjectScope;
    const subjects: RateLimitSubject[] =
      scope === "ip"
        ? [{ ip }]
        : scope === "ip_and_account"
          ? [{ ip }, { accountId }]
          : [{ accountId }];
    if (!caller && scope !== "ip") throw new SocialRouteError("unauthorized");
    for (const subject of subjects) {
      const decision = await dependencies.limiter.consume(bucket, subject);
      if (!decision.allowed) throw new SocialRouteError("rate_limited", { retryAfterSeconds: decision.retryAfterSeconds });
    }
  }

  async function resolveAccount(mode: NonNullable<SocialRouteSpec["account"]>, caller: SocialCaller | null): Promise<SocialAccount | null> {
    if (mode === "none") return null;
    if (!caller && mode === "required") throw new SocialRouteError("unauthorized");
    const account = !caller
      ? null
      : caller.kind === "privy"
        ? await dependencies.accounts.resolve(caller.did)
        : await dependencies.accounts.resolveWallet(caller.address);
    if (!account && mode === "required") throw new SocialRouteError("account_required");
    return account;
  }

  return Object.freeze({
    route(spec: SocialRouteSpec, handler: SocialRouteHandler): (request: Request, client: ClientAddress) => Promise<Response> {
      assertSpec(spec);
      const cacheControl = spec.cache === "private" ? PRIVATE_NO_STORE : NO_STORE;
      const sharedCacheControl =
        spec.cache !== undefined && spec.cache in SHARED_CACHE_CONTROL ? SHARED_CACHE_CONTROL[spec.cache as keyof typeof SHARED_CACHE_CONTROL] : null;
      const accountMode = spec.account ?? "none";
      return async (request, client) => {
        const requestId = createRequestId();
        const successCacheControl = sharedCacheControl ?? cacheControl;
        let clearWallet = false;
        const started = performance.now();
        let status = 500;
        try {
          const authenticated = await authenticate(spec, request, client);
          const caller = authenticated.caller;
          clearWallet = authenticated.clearWallet;
          if (spec.bucket) await consume(spec.bucket, caller, client.rateKey);
          const account = await resolveAccount(accountMode, caller);
          const response = await handler(Object.freeze({
            request,
            requestId,
            client,
            caller,
            account,
            ...visibility(dependencies.tradingVisible(request)),
            json: (body: unknown, status = 200) =>
              socialJson(requestId, body, status, status === 200 ? successCacheControl : cacheControl),
            consume: (bucket: SocialRateBucket) => consume(bucket, caller, client.rateKey),
            consumeAccount: async (bucket: SocialRateBucket) => {
              if (!account) throw new SocialRouteError("account_required");
              await consume(bucket, caller, client.rateKey, account.account_id);
            },
            transaction: <Result>(
              operation: (
                social: ModuleTransaction<"social">,
                transaction: TransactionContext,
              ) => Promise<Result>,
              options?: TransactionOptions,
            ) =>
              withTransaction(
                dependencies.primary(),
                (transaction) => operation(transaction.forModule("social"), transaction),
                options,
              ),
          }));
          status = response.status;
          return clearWallet ? withClearedWalletCookies(response) : response;
        } catch (caught) {
          const error = toSocialRouteError(caught);
          status = error.status;
          if (error.status >= 500 || !spec.name.startsWith("GET ")) {
            recordMetric("social.route", {
              route: spec.name,
              requestId,
              status: error.status,
              outcome: error.status >= 500 ? "error" : "refused",
              code: error.code,
              cause: socialErrorCause(caught),
              durationMs: Math.round(performance.now() - started),
            });
          }
          const answer = socialErrorResponse(requestId, error, cacheControl);
          return clearWallet || (caught as { clearWallet?: unknown } | null | undefined)?.clearWallet === true ? withClearedWalletCookies(answer) : answer;
        } finally {
          if (status < 400 || (status < 500 && spec.name.startsWith("GET "))) recordAnswer(spec.name, requestId, status, started);
        }
      };
    },
  });
}

export type SocialRouteKit = ReturnType<typeof createSocialRouteKit>;

/**
 * Reads at most `maxBytes` (default 4 KiB) of a request body. A declared
 * `Content-Length` over the limit is refused unread; a streamed body that
 * passes it is cancelled. Both are `body_too_large`.
 */
export async function readSocialBody(
  request: Request,
  maxBytes = SOCIAL_BODY_LIMIT_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SocialRouteError("body_too_large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SocialRouteError("body_too_large");
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

/**
 * Reads a closed JSON object body of at most 4 KiB: exactly the `required`
 * keys plus any of `optional`. Another content type, invalid UTF-8, invalid
 * JSON, a non-object or an unknown or missing key is `invalid_request`; a
 * larger body is `body_too_large`.
 */
export async function readSocialJson<const Required extends string, const Optional extends string = never>(
  request: Request,
  required: readonly Required[],
  optional: readonly Optional[] = [],
  maxBytes = SOCIAL_BODY_LIMIT_BYTES,
): Promise<Record<Required, unknown> & Partial<Record<Optional, unknown>>> {
  const shape = Object.fromEntries([
    ...required.map((key) => [key, z.unknown().nonoptional()]),
    ...optional.map((key) => [key, z.unknown().optional()]),
  ]);
  return readSocialJsonWithSchema(request, z.strictObject(shape), maxBytes) as Promise<
    Record<Required, unknown> & Partial<Record<Optional, unknown>>
  >;
}

export async function readSocialJsonWithSchema<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  maxBytes = SOCIAL_BODY_LIMIT_BYTES,
): Promise<z.output<Schema>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new SocialRouteError("invalid_request");
  }
  const body = await readSocialBody(request, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new SocialRouteError("invalid_request");
  }
  return socialInput(schema, value);
}
