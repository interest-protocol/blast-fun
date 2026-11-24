// How the coin page's browser destinations (Holders, the chart and Activity)
// read blast-infra's data: never from blast-infra itself (its `/v1` takes a
// server-only key), but through this app's same-origin
// `/api/launchpad/market/*` routes (`modules/launchpad-market`), which relay
// the exact `/v1` answer. The validated `/v1` client still builds and checks
// every HTTP read; only its fetch goes to this app. Holders and Activity use
// `use-market-poll.ts`; the chart also receives the same-origin market SSE feed.

import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import type { MarketDataDependencies } from "@blast/core/modules/read-routing/market-data.ts";

/** How often a destination re-reads while the tab is visible, so a halted or lagging engine turns Stale. */
export const POLL_MS = 15_000;

/** The same-origin routes that relay the `/v1` reads the coin page needs. */
export const MARKET_ROUTE_PREFIX = "/api/launchpad/market";

/**
 * The validated `/v1` client's origin in a browser: a reserved name no
 * request ever goes to. The client builds `/v1` URLs on it, and the browser
 * fetch maps each to this app's route (`marketRoute`).
 */
export const BROWSER_V1_ORIGIN = "https://blast-infra.invalid";

/**
 * The same-origin route that relays a `/v1` read: `/v1/<path>?<query>` on
 * `BROWSER_V1_ORIGIN` becomes `/api/launchpad/market/<path>?<query>`. Any
 * other URL is refused, so this fetch reaches nothing but this app.
 */
export function marketRoute(input: RequestInfo | URL): string {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== BROWSER_V1_ORIGIN || !url.pathname.startsWith("/v1/")) {
    throw new TypeError("The browser's market reads go only to this app's /api/launchpad/market routes.");
  }
  return `${MARKET_ROUTE_PREFIX}/${url.pathname.slice("/v1/".length)}${url.search}`;
}

/**
 * The validated `/v1` client's dependencies in a browser: each read goes to
 * this app's relaying route (same origin), with a 3 s timeout. `fetch` is
 * called unbound, as browsers require.
 */
export function browserMarketDependencies(
  expected: ExpectedDeployment | null,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): MarketDataDependencies {
  return {
    origin: BROWSER_V1_ORIGIN,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetcher(marketRoute(input), init)) as typeof fetch,
    now,
    timeoutMs: 3_000,
    statusCacheMs: 1_000,
    expected,
  };
}

/** An answer behind its hint is read once more after this long. */
export const BEHIND_RETRY_MS = 1_000;

/** The checkpoint an answer body reflects; -1 when it names none. */
async function answeredAt(response: Response): Promise<number> {
  try {
    const checkpoint = ((await response.json()) as { provenance?: { checkpoint?: unknown } } | null)?.provenance?.checkpoint;
    return typeof checkpoint === "number" ? checkpoint : -1;
  } catch {
    return -1;
  }
}

/** A hinted read's answer, kept whole so each reader that shares it gets its own `Response`. */
type SharedAnswer = Readonly<{ status: number; headers: Headers; body: string }>;

/** The tab's hinted reads in flight, by URL: one hint makes several destinations ask the same (Activity's flow and the page's figures read the curve). */
const sharedReads = new Map<string, Promise<SharedAnswer>>();

/**
 * `dependencies` for the reads a live hint caused: each but `/v1/status`
 * names the hint's checkpoint (`at`), the one CDN key every viewer of the
 * coin asks for it. An answer behind `at` (blast-infra not yet as far as the
 * hint) is read once more after `BEHIND_RETRY_MS`; if that read fails, the
 * first answer stands. The same hinted read asked again while it is in
 * flight in this tab shares it, so it counts once against the route's
 * per-IP budget. A null `at` (a poll) leaves `dependencies` as they are.
 */
export function atCheckpoint(
  dependencies: MarketDataDependencies,
  at: number | null,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): MarketDataDependencies {
  if (at === null) return dependencies;
  const read = async (url: URL, init?: RequestInit): Promise<Response> => {
    const first = await dependencies.fetch(url, init);
    if (first.status !== 200 || (await answeredAt(first.clone())) >= at) return first;
    await wait(BEHIND_RETRY_MS);
    if (init?.signal?.aborted) return first;
    try {
      return await dependencies.fetch(url, init);
    } catch {
      return first;
    }
  };
  const fetchAt = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/v1/status") return dependencies.fetch(url, init);
    url.search = `${url.search ? `${url.search}&` : "?"}at=${at}`;
    let shared = sharedReads.get(url.href);
    if (!shared) {
      shared = read(url, init).then(async (response) => ({ status: response.status, headers: response.headers, body: await response.text() }));
      const settled = shared;
      const forget = () => {
        if (sharedReads.get(url.href) === settled) sharedReads.delete(url.href);
      };
      settled.then(forget, forget);
      sharedReads.set(url.href, settled);
    }
    const answer = await shared;
    return new Response(answer.body, { status: answer.status, headers: answer.headers });
  };
  return { ...dependencies, fetch: fetchAt as typeof fetch };
}
