import { GATE_REFRESH_PATH, isGateRefusal } from "@blast/core/lib/web-security/api-gate-protocol.ts";

/**
 * The browser side of the API gate (docs/security/bot-protection.md). The
 * gate cookie is HttpOnly and arrives with every page, so a same-origin
 * `/api/*` fetch normally just carries it. This wrapper covers the rest:
 *
 * - a same-origin `/api/*` call made with `credentials: "same-origin"` is sent with
 *   `same-origin` instead (without cookies it could never pass the gate);
 * - a `gate_required` 401 (a tab open past the cookie's two hours) calls
 *   `GET /api/gate` once, shared by every call that hit it at the same time,
 *   then retries the call once. A body that cannot be sent twice (a stream)
 *   is not retried.
 *
 * Other origins and other paths pass through untouched.
 */

const WRAPPED = Symbol.for("blast.apiGate.fetch");

type Fetch = typeof globalThis.fetch;
type GateAwareFetch = Fetch & { [WRAPPED]?: true };

/** The page's origin, when there is one (the browser); relative URLs are same-origin regardless. */
function pageOrigin(): string | null {
  const location = (globalThis as { location?: { origin?: unknown } }).location;
  return typeof location?.origin === "string" ? location.origin : null;
}

/** The pathname of a same-origin request, or null for another origin. */
function sameOriginPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw.split(/[?#]/, 1)[0]!;
  const origin = pageOrigin();
  if (!origin) return null;
  try {
    const url = new URL(raw, origin);
    return url.origin === origin ? url.pathname : null;
  } catch {
    return null;
  }
}

function gated(path: string | null): boolean {
  return path !== null && (path === "/api" || path.startsWith("/api/")) && path !== GATE_REFRESH_PATH;
}

function replayable(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (typeof ReadableStream !== "undefined" && init?.body instanceof ReadableStream) return false;
  return !(input instanceof Request) || input.body === null || !input.bodyUsed;
}

/** Wraps `base` (default: the current global fetch) with the gate's credentials rule and one retry. */
export function createGateAwareFetch(base: Fetch): Fetch {
  if ((base as GateAwareFetch)[WRAPPED]) return base;
  let refreshing: Promise<boolean> | null = null;
  const refresh = () =>
    (refreshing ??= base(GATE_REFRESH_PATH, { method: "GET", credentials: "same-origin", cache: "no-store" })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      }));

  const wrapped: GateAwareFetch = async (input, init) => {
    if (!gated(sameOriginPath(input))) return base(input, init);
    const omitted = init?.credentials === "omit" || (init?.credentials === undefined && input instanceof Request && input.credentials === "omit");
    const sendInit: RequestInit | undefined = omitted ? { ...init, credentials: "same-origin" } : init;
    const canRetry = replayable(input, init);
    // A Request's body can be read once: keep a copy for the retry.
    const retryInput = canRetry && input instanceof Request && input.body !== null ? input.clone() : input;
    const response = await base(input, sendInit);
    if (!isGateRefusal(response) || !canRetry || init?.signal?.aborted) return response;
    if (!(await refresh())) return response;
    return base(retryInput, sendInit);
  };
  wrapped[WRAPPED] = true;
  return wrapped;
}

/**
 * `fetch` with the gate's rule and retry, whatever `globalThis.fetch` is now
 * (installed or not): the shared client helpers call this by default.
 */
export const gatedFetch: Fetch = (input, init) => {
  const base = globalThis.fetch;
  let wrapper = wrappers.get(base);
  if (!wrapper) wrappers.set(base, (wrapper = createGateAwareFetch(base)));
  return wrapper(input, init);
};

/** One wrapper per underlying fetch, so concurrent refusals share one refresh. */
const wrappers = new WeakMap<Fetch, Fetch>();

/**
 * Replaces `globalThis.fetch` with the gate-aware wrapper, once, in the
 * browser, so every caller (including ones that take `fetch` as a default
 * parameter) gets the retry. A no-op on the server.
 */
export function installGateAwareFetch(target: { fetch: Fetch } = globalThis): void {
  if (typeof window === "undefined" && target === globalThis) return;
  if ((target.fetch as GateAwareFetch)[WRAPPED]) return;
  target.fetch = createGateAwareFetch(target.fetch.bind(target));
}

let refreshingGate: Promise<boolean> | null = null;
/** A hung refresh counts as failed, so a waiting stream stops; shorter than the market hub's 10 s hello deadline. */
const GATE_REFRESH_TIMEOUT_MS = 5_000;

/**
 * `GET /api/gate` once for every caller waiting on it now: true when a new
 * cookie was issued. For streams, which cannot see a refusal's status.
 */
export function refreshGate(): Promise<boolean> {
  return (refreshingGate ??= globalThis
    .fetch(GATE_REFRESH_PATH, { method: "GET", credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(GATE_REFRESH_TIMEOUT_MS) })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshingGate = null;
    }));
}
