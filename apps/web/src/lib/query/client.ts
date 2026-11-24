import { PublicError, type ErrorDiagnostic } from "#web/lib/errors.ts";
import { QueryClient, type DefaultOptions, type QueryClientConfig } from "@tanstack/react-query";

/**
 * Server state (OA-38): one TanStack Query client per browser session, a fresh
 * one per server render. `docs/product/social-feed/ui-libraries.md` §3.13 is
 * the guide: how to key a read, how long it stays fresh, what invalidates it.
 *
 * Client-only state (sheets, drafts, device preferences) is zustand's job, not
 * this cache's.
 */

/**
 * How long a public read stays fresh: the CDN caches every public social read
 * for `s-maxage=10`, so asking again sooner returns the same answer from the
 * edge. A hint (`/v1/ws` activity) or a mutation invalidates sooner.
 */
export const PUBLIC_STALE_MS = 10_000;

/**
 * How long a signed-in read (`private, no-store`) stays fresh before a remount
 * or a reconnect reads it again. Mutations invalidate exactly what they change,
 * so this only bounds how old a read can be when nothing told us it changed.
 */
export const VIEWER_STALE_MS = 15_000;

/** How long an unused read stays in memory after its last consumer unmounts. */
export const GC_MS = 5 * 60_000;

/** At most this many retries of a transient failure (so three attempts). */
export const MAX_RETRIES = 2;

const QUERY_REFUSAL_MESSAGES = new Map([
  ["service_unavailable", "Blast is temporarily unavailable. Try again soon."],
  ["rate_limited", "Too many requests. Try again later."],
]);

/**
 * A definitive answer that a retry will not change: a `4xx`, or a published
 * refusal (`{"error":{"code":…}}`) from a social route. Only transient server failures are retried.
 */
export class QueryRefusal extends PublicError {
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
  readonly requestId: string | undefined;
  constructor(code: string, options: Readonly<{ httpStatus?: number | null; retryAfterSeconds?: number | null; requestId?: string }> = {}) {
    super(QUERY_REFUSAL_MESSAGES.get(code) ?? "The server refused the read. Review it and retry.", { ...options, code });
    this.name = "QueryRefusal";
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.requestId = options.requestId;
  }
}

/** A failure a retry may fix: the network, a `5xx`, a body that did not parse. */
export class QueryTransientError extends PublicError {
  readonly httpStatus: number | null;
  readonly requestId: string | undefined;
  constructor(message = "The read could not load. Check your connection and retry.", httpStatus: number | null = null, requestId?: string, code = "network_unavailable") {
    super(message, { httpStatus, requestId, code });
    this.name = "QueryTransientError";
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

/** The error for a non-2xx `Response` from a public read: `4xx` is final, anything else may be retried. */
export function httpError(status: number, what = "The read"): Error {
  return status >= 400 && status < 500
    ? new QueryRefusal(`http_${status}`, { httpStatus: status })
    : new QueryTransientError(`${what} answered ${status}.`, status);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** Whether a failed read is retried: a transient failure, up to `MAX_RETRIES` times; never a `4xx` or an abort. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (isAbort(error)) return false;
  if (error instanceof QueryRefusal) return error.httpStatus !== null && error.httpStatus >= 500;
  if (error instanceof PublicError && error.code === "request_cancelled") return false;
  if (error instanceof PublicError && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500) return false;
  return true;
}

/** Equal-jitter exponential backoff, capped at 8 s; outage retries must not align. */
export function retryDelay(attemptIndex: number): number {
  return Math.round(Math.min(1_000 * 2 ** attemptIndex, 8_000) * (0.5 + Math.random() / 2));
}

/** How often an on-screen read that failed on an outage asks again once its retries ran out. */
export const FAILED_RECHECK_MS = 15_000;

/**
 * Whether a failed read can heal by itself: a `PublicError` for the network,
 * a `5xx`, a rate limit, or a signed-in read refused as `unauthorized` (the
 * session's token rotates under it). A definite answer (`404`, a bad
 * request) and any other error stay put.
 */
function healsByItself(error: unknown): boolean {
  if (!(error instanceof PublicError)) return false;
  if (error.code === "request_cancelled") return false;
  const status = error.httpStatus;
  return status === null || status >= 500 || status === 429 || error.code === "unauthorized";
}

type PolledQuery = Readonly<{ state: Readonly<{ status: string; error: unknown; errorUpdatedAt: number; errorUpdateCount: number }> }>;

/**
 * The default `refetchInterval`: a read on screen whose last answer was an
 * outage asks again after `FAILED_RECHECK_MS`, then twice and four times
 * that (or later when the server said so), so its error clears once the
 * backend is back, without a reload, and a long outage is not hammered. A
 * read with its own interval keeps it: that interval re-reads an error too.
 *
 * The answer is a pure function of the query's state: TanStack recomputes the
 * interval on every render and restarts the timer when it changes, so a fresh
 * random jitter would push the recheck back forever on a busy screen.
 */
export function recheckFailed(query: PolledQuery): number | false {
  const { status, error, errorUpdatedAt, errorUpdateCount } = query.state;
  if (status !== "error" || !healsByItself(error)) return false;
  const after = error instanceof PublicError ? (error.retryAfterSeconds ?? 0) * 1_000 : 0;
  const backoff = 2 ** Math.min(Math.max(errorUpdateCount - 1, 0), 2);
  const jitter = 0.75 + (errorUpdatedAt % 1_000) / 2_000;
  return Math.max(after, Math.round(FAILED_RECHECK_MS * backoff * jitter));
}

/**
 * The app's defaults. Each `useQuery` may override them; the guide says when.
 *
 * - `staleTime`: the public reads' CDN window, so a remount or a second
 *   consumer inside it reads the cache, not the network.
 * - `refetchOnWindowFocus: false`: no storm of reads when the tab returns.
 *   The live surfaces already look on visibility through their freshness
 *   source; a read that needs it opts in.
 * - `retry`: transient failures only, with backoff; mutations never retry
 *   (a commit, a claim or a swap is not idempotent from the browser's side).
 */
export const QUERY_DEFAULTS: DefaultOptions = {
  queries: {
    staleTime: PUBLIC_STALE_MS,
    gcTime: GC_MS,
    retry: shouldRetry,
    retryDelay,
    refetchInterval: recheckFailed,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  },
  mutations: { retry: false },
};

/** A client with the app's defaults; `config` overrides them (tests). */
export function makeQueryClient(config: QueryClientConfig = {}): QueryClient {
  return new QueryClient({
    ...config,
    defaultOptions: {
      ...config.defaultOptions,
      queries: { ...QUERY_DEFAULTS.queries, ...config.defaultOptions?.queries },
      mutations: { ...QUERY_DEFAULTS.mutations, ...config.defaultOptions?.mutations },
    },
  });
}

let browserClient: QueryClient | null = null;

/**
 * The browser session's client (created once), or a fresh one on the server,
 * so no viewer's cache ever outlives a request there.
 */
export function getQueryClient(): QueryClient {
  // Read at call time, not query-core's load-time `isServer`: a test installs
  // its DOM after the package may already have loaded.
  if (typeof window === "undefined") return makeQueryClient();
  browserClient ??= makeQueryClient();
  return browserClient;
}

/** The shape of `callSocialApi`'s answer. */
export type ApiResultLike<Body> =
  | Readonly<{ status: "ok"; body: Body }>
  | Readonly<{ status: "refused"; code: string; retryAfterSeconds: number | null }>
  | Readonly<{ status: "error" }>;

/**
 * A `queryFn`'s bridge from `callSocialApi` (OA-16 keeps every signed-in read
 * on it): the body, or a thrown `QueryRefusal` (never retried) or
 * `QueryTransientError` (retried with backoff).
 */
export function unwrapApiResult<Body>(result: ApiResultLike<Body> & ErrorDiagnostic): Body {
  if (result.status === "ok") return result.body;
  if (result.status === "refused") throw new QueryRefusal(result.code, { httpStatus: result.httpStatus, retryAfterSeconds: result.retryAfterSeconds, requestId: result.requestId });
  throw new QueryTransientError(undefined, result.httpStatus ?? null, result.requestId, result.code ?? "network_unavailable");
}

/** The other way, for a hook whose public shape is an `ApiResult`: a failed query's error as the result it stood for. */
export function apiResultOfError(error: unknown): Readonly<{ status: "refused"; code: string; retryAfterSeconds: number | null; requestId?: string; httpStatus?: number }> | Readonly<{ status: "error"; requestId?: string; code?: string; httpStatus?: number; retryAfterSeconds?: number }> {
  const reference = error instanceof PublicError ? { ...(error.requestId ? { requestId: error.requestId } : {}), ...(error.httpStatus !== null ? { httpStatus: error.httpStatus } : {}), code: error.code, ...(error.retryAfterSeconds !== null ? { retryAfterSeconds: error.retryAfterSeconds } : {}) } : {};
  return error instanceof QueryRefusal ? { status: "refused", code: error.code, retryAfterSeconds: error.retryAfterSeconds, ...reference } : { status: "error", ...reference };
}
