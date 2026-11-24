import { z } from "zod";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { ContractViolation } from "../launchpad-contract/decimal.ts";
import {
  deploymentMismatch,
  parseInfraProvenance,
  type ExpectedDeployment,
} from "../launchpad-contract/provenance.ts";
import {
  WORKLOAD_ROUTES,
  type MarketResource,
  type Provenance,
  type RoutedRead,
} from "./resources.ts";

/**
 * Where and how one `/v1` read goes. On the server, the defaults of
 * `blast-infra.ts` (server-only): blast-infra's origin and the fetch that
 * adds its key. In the browser,
 * `browserMarketDependencies()`: the same-origin `/api/launchpad/market`
 * routes, never blast-infra.
 */
export type MarketDataDependencies = Readonly<{
  origin: string;
  fetch: typeof fetch;
  now: () => number;
  timeoutMs: number;
  /** How long one `/v1/status` answer serves an origin's refusals; 0 reads it every time. */
  statusCacheMs: number;
  /** The deployment this app serves; an answer about another is unavailable. Null checks nothing. */
  expected: ExpectedDeployment | null;
}>;

/** blast-infra's answer: its body and HTTP status, a refusal (4xx) included. */
export type MarketAnswer<T> = Readonly<{ httpStatus: number; body: T }>;

/** The `provenance` of an answer body, or null when it has none that meets the contract. */
function bodyProvenance(body: unknown): Provenance | null {
  try {
    return parseInfraProvenance((body as { provenance?: unknown } | null)?.provenance);
  } catch (error) {
    if (error instanceof ContractViolation) return null;
    throw error;
  }
}

type Fetched = Readonly<{ status: number; body: unknown }>;

async function get(dependencies: MarketDataDependencies, url: URL): Promise<Fetched> {
  const response = await dependencies.fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(dependencies.timeoutMs),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: an upstream proxy's page. Only the status is used then.
  }
  return { status: response.status, body };
}

function errorCode(fetched: Fetched): string {
  const code = (fetched.body as { error?: { code?: unknown } } | null)?.error?.code;
  return z.string().regex(/^[a-z_]{1,32}$/).safeParse(code).success ? code as string : `http_${fetched.status}`;
}

const statusCache = processSingleton(
  "read-routing.market-status",
  () => new Map<string, { at: number; reading: Promise<Fetched> }>(),
);

/**
 * One `/v1/status` read per origin per `statusCacheMs`, shared by concurrent
 * reads, for the provenance of a refusal (a 4xx body has none). A failure is
 * not kept.
 */
function readStatus(dependencies: MarketDataDependencies): Promise<Fetched> {
  const url = new URL("/v1/status", dependencies.origin);
  if (dependencies.statusCacheMs <= 0) return get(dependencies, url);
  const now = dependencies.now();
  const cached = statusCache.get(dependencies.origin);
  if (cached && now - cached.at < dependencies.statusCacheMs) return cached.reading;
  const reading = get(dependencies, url);
  statusCache.set(dependencies.origin, { at: now, reading });
  const forget = () => {
    if (statusCache.get(dependencies.origin)?.reading === reading) statusCache.delete(dependencies.origin);
  };
  reading.then((fetched) => fetched.status === 200 || forget(), forget);
  return reading;
}

/**
 * Reads a blast-infra `/v1` route: from the server with the defaults of
 * `blast-infra.ts` (server-only), or from a browser
 * through `launchpad-contract/browser-holders.ts`, `browser-chart.ts` or
 * `browser-activity.ts` with `browserMarketDependencies()`, whose fetch reads
 * the same-origin `/api/launchpad/market` route that relays it. Every answer
 * body carries its `provenance` (network, SDK deployment fingerprint,
 * committed checkpoint, observation time, lag), which decides fresh or stale;
 * an answer without a valid one, or about another deployment, and a
 * starting, unreachable, refusing-this-server (401/403) or failing engine are
 * Unavailable. A refusal (other 4xx) has no body provenance and takes the
 * engine's from `/v1/status`. There is no fallback: the web app never
 * recomputes market data from SQL.
 */
export async function readMarketData<T = unknown>(
  resource: MarketResource,
  path: string,
  dependencies: MarketDataDependencies,
): Promise<RoutedRead<MarketAnswer<T>>> {
  const url = new URL(path, dependencies.origin);
  if (!path.startsWith("/v1/") || url.origin !== dependencies.origin || !url.pathname.startsWith("/v1/")) {
    throw new Error("readMarketData takes a blast-infra /v1 path.");
  }
  const observedAt = dependencies.now();
  const unknown: Provenance = {
    source: "blast-infra",
    network: null,
    deployment: null,
    checkpoint: null,
    timestampMs: null,
    observedAt,
    lagMs: null,
  };
  const unavailable = (reason: string, provenance: Provenance = unknown): RoutedRead<never> => {
    recordMetric("read.degraded", { resource, outcome: "unavailable", reason });
    return { status: "unavailable", provenance: { ...provenance, reason } };
  };

  let answer: Fetched;
  try {
    answer = await get(dependencies, url);
  } catch {
    return unavailable("unreachable");
  }
  if (answer.status >= 500) return unavailable(errorCode(answer));
  // blast-infra refused this server's key: nothing it says is an answer.
  if (answer.status === 401 || answer.status === 403) return unavailable("unauthorized");
  const data = { httpStatus: answer.status, body: answer.body as T };

  let provenance: Provenance | null;
  if (answer.status === 200) {
    provenance = bodyProvenance(answer.body);
    if (!provenance) return unavailable("provenance-invalid");
  } else {
    const status = await readStatus(dependencies).catch(() => null);
    provenance = status?.status === 200 ? bodyProvenance(status.body) : null;
    if (!provenance) {
      recordMetric("read.degraded", { resource, outcome: "stale", reason: "status-unavailable" });
      return { status: "stale", data, provenance: { ...unknown, reason: "status-unavailable" } };
    }
  }

  const mismatch = deploymentMismatch(provenance, dependencies.expected);
  if (mismatch) return unavailable(mismatch, provenance);
  if (provenance.checkpoint === null || provenance.lagMs === null) return unavailable("no_checkpoint", provenance);
  if (provenance.lagMs > WORKLOAD_ROUTES[resource].maxLagMs) {
    recordMetric("read.degraded", { resource, outcome: "stale", lagMs: provenance.lagMs });
    return { status: "stale", data, provenance: { ...provenance, reason: "lagging" } };
  }
  return { status: "fresh", data, provenance };
}
