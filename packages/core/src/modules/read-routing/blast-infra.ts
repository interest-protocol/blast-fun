import { z } from "zod";
// How this server reaches blast-infra: its origin, its API key, and the one
// header every server and worker request to it carries. Server-only: the
// browser never talks to blast-infra (it reads the same-origin
// `/api/launchpad/market/*` routes, `modules/launchpad-market`), so no client
// module may import this file (client-boundary.test.ts walks the client
// graph). It imports no bundler-only marker and no `@/` path, so the presale
// worker and the scripts can load it under plain Node.

import { deploymentIdentity } from "../../lib/config/deployment-identity.ts";
import { trustedUrl } from "../../lib/config/trusted-origin.ts";
import { expectedDeployment } from "../launchpad-contract/provenance.ts";
import type { MarketDataDependencies } from "./market-data.ts";
import { SUI_OBJECT_ID_SOURCE } from "@blast/core/lib/sui/ids.ts";

if (typeof window !== "undefined") {
  throw new Error(
    "modules/read-routing/blast-infra.ts is server-only: the browser never reaches blast-infra.",
  );
}

/**
 * The request header that carries `BLAST_INFRA_API_KEY` to blast-infra on
 * every `/v1` and `/v1/ws` request. blast-infra checks exactly this header
 * name (lowercase, as HTTP/2 sends it).
 */
export const BLAST_INFRA_KEY_HEADER = "x-blast-infra-key";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Printable ASCII without spaces, 32 to 512 characters: a header value that
 * cannot split a header or carry a line break.
 */
const API_KEY = /^[\x21-\x7e]{32,512}$/;

/**
 * blast-infra's origin, for this server's `/v1` reads: `BLAST_INFRA_ORIGIN`,
 * server-only. The deprecated `NEXT_PUBLIC_BLAST_INFRA_ORIGIN` is no longer
 * read (review L8): `NEXT_PUBLIC_` is Next's browser-exposed namespace, and
 * the browser never talks to blast-infra. Required: without it market reads
 * are unconfigured, not served from the web app's database. It must name one
 * DNS host or IP address, never a wildcard, and use https in production.
 */
export function marketDataOrigin(
  environment: Environment = process.env,
): string {
  const raw = environment.BLAST_INFRA_ORIGIN?.trim();
  if (!raw) throw new Error("BLAST_INFRA_ORIGIN is required for market reads.");
  return trustedUrl("BLAST_INFRA_ORIGIN", raw, {
    shape: "origin",
    http: deploymentIdentity(environment).production ? "never" : "any",
    plainHost: true,
  }).origin;
}

/** blast-infra's settings as a server parses them once: `marketDataOrigin`, `blastInfraApiKey`, `blastInfraReadOrigin`. */
export type BlastInfraSettings = Readonly<{
  origin: string;
  apiKey: string | null;
  readOrigin: string | null;
}>;

/**
 * The secret this server sends blast-infra (`BLAST_INFRA_API_KEY`), or null
 * when unset (development, or before blast-infra requires one). A set value
 * that is not 32 to 512 printable characters is a configuration error; the
 * message never repeats it.
 */
export function blastInfraApiKey(
  environment: Environment = process.env,
): string | null {
  const raw = environment.BLAST_INFRA_API_KEY?.trim();
  if (!raw) return null;
  if (!z.string().regex(API_KEY).safeParse(raw).success) {
    throw new Error(
      "BLAST_INFRA_API_KEY must be 32 to 512 printable characters without spaces.",
    );
  }
  return raw;
}

function requestUrl(input: RequestInfo | URL): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}

type IndependentReadRoute = Readonly<{ origin: string }>;

/** A separately verified complete committed reader requires an explicit opt-in. */
function independentReadOrigin(
  environment: Environment,
): IndependentReadRoute | null {
  const mode = environment.BLAST_INFRA_READ_MODE?.trim();
  if (mode && mode !== "committed-markets")
    throw new Error(
      "BLAST_INFRA_READ_MODE must be committed-markets or empty.",
    );
  if (!mode) return null;
  const url = trustedUrl(
    "BLAST_INFRA_READ_ORIGIN",
    environment.BLAST_INFRA_READ_ORIGIN?.trim(),
    { shape: "origin", http: "loopback", plainHost: true },
  );
  return { origin: url.origin };
}

const ID_SEGMENT = SUI_OBJECT_ID_SOURCE;
const COMMITTED_READ_PATHS = [
  /^\/v1\/(?:status|stack|quotes|pools|bonding|traders\/top|presales|presales\/policy|vaults|partners|launchpad\/policy|creator-claims)$/,
  new RegExp(
    `^/v1/pools/(?:blast_curve|cetus|bluefin)/${ID_SEGMENT}(?:/(?:trades|candles))?$`,
  ),
  /^\/v1\/coins\/[A-Za-z0-9_:%]{1,1024}(?:\/(?:trades|candles|holders))?$/,
  new RegExp(
    `^/v1/launches/${ID_SEGMENT}/(?:activity|opening-round/bidders|rewards)$`,
  ),
  new RegExp(
    `^/v1/wallets/${ID_SEGMENT}(?:/(?:positions|trades|presales|presale-vesting|launches|launch-rewards|vault-rewards))?$`,
  ),
  new RegExp(
    `^/v1/presales/${ID_SEGMENT}(?:/(?:commitments|wallets/${ID_SEGMENT}))?$`,
  ),
  new RegExp(`^/v1/vaults/${ID_SEGMENT}(?:/rewards)?$`),
  new RegExp(`^/v1/partners/${ID_SEGMENT}$`),
];

function independentReadInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  origin: string,
  reader: IndependentReadRoute,
): RequestInfo | URL {
  const url = requestUrl(input);
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  if (url.origin !== origin || (method !== "GET" && method !== "HEAD"))
    return input;
  const selected = COMMITTED_READ_PATHS.some((path) => path.test(url.pathname));
  if (!selected) return input;
  const target = new URL(
    `${url.pathname}${url.search}${url.hash}`,
    reader.origin,
  );
  return input instanceof Request ? new Request(target, input) : target;
}

/**
 * The committed reader's origin under `BLAST_INFRA_READ_MODE=committed-markets`,
 * else null (reads stay on the writer). Invalid opt-in throws; never a fallback.
 */
export function blastInfraReadOrigin(
  environment: Environment = process.env,
): string | null {
  return independentReadOrigin(environment)?.origin ?? null;
}

/**
 * Server-side WebSocket connections go only to the committed reader: the
 * writer serves no `/v1/ws`. Without `BLAST_INFRA_READ_MODE=committed-markets`
 * this throws, a configuration error rather than a connection to a 404.
 */
export function blastInfraSocketUrl(
  environment: Environment = process.env,
): URL {
  const origin = blastInfraReadOrigin(environment);
  if (!origin)
    throw new Error(
      "Infra WebSockets require BLAST_INFRA_READ_MODE=committed-markets and BLAST_INFRA_READ_ORIGIN.",
    );
  const url = new URL("/v1/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

/**
 * The fetch every server and worker request to blast-infra goes through: it
 * adds `x-blast-infra-key` (`BLAST_INFRA_API_KEY`) to a request for
 * blast-infra's origin (`origin`, else `marketDataOrigin()`), and to nothing
 * else, so the key never reaches another host. A keyed request never follows
 * a redirect (`redirect: "error"`, review L7): a 3xx from the engine, or from
 * anything in front of it, would otherwise carry the header to wherever it
 * points; the fetch rejects instead, which callers treat as the engine being
 * unreachable. Explicit BLAST_INFRA_READ_MODE=committed-markets selects canonical
 * market/presale reads at BLAST_INFRA_READ_ORIGIN. Without that selection, hot
 * reads use the writer intentionally. Rebuild the client after changing its mode.
 * Reader errors never fall back. Admission and response validation stay with callers.
 * The key is read per request and never logged.
 */
export function blastInfraFetch(
  options: Readonly<{
    origin?: string;
    fetch?: typeof fetch;
    environment?: Environment;
    /** Settings parsed once by the caller; when set, the environment is not read. */
    infra?: BlastInfraSettings;
  }> = {},
): typeof fetch {
  const environment = options.environment ?? process.env;
  const { infra } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  // Configuration is trusted server configuration, never a request-selected host.
  // Invalid explicit opt-in refuses construction; there is no writer fallback.
  const reader = infra
    ? infra.readOrigin === null ? null : { origin: infra.readOrigin }
    : independentReadOrigin(environment);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = infra ? infra.apiKey : blastInfraApiKey(environment);
    if (key === null && reader === null) return fetcher(input, init);
    const origin = new URL(infra?.origin ?? options.origin ?? marketDataOrigin(environment))
      .origin;
    if (requestUrl(input).origin !== origin) return fetcher(input, init);
    const target =
      reader === null
        ? input
        : independentReadInput(input, init, origin, reader);
    if (key === null) return fetcher(target, init);
    const headers = new Headers(
      input instanceof Request ? input.headers : undefined,
    );
    for (const [name, value] of new Headers(init?.headers))
      headers.set(name, value);
    headers.set(BLAST_INFRA_KEY_HEADER, key);
    return fetcher(target, { ...init, headers, redirect: "error" });
  }) as typeof fetch;
}

/**
 * This server's blast-infra for the validated `/v1` client: its origin, the
 * keyed fetch, a 3 s timeout and the expected deployment. Throws when
 * unconfigured.
 */
export function defaultMarketDataDependencies(
  environment: Environment = process.env,
): MarketDataDependencies {
  const origin = marketDataOrigin(environment);
  blastInfraApiKey(environment);
  return {
    origin,
    fetch: blastInfraFetch({ origin, environment }),
    now: Date.now,
    timeoutMs: 3_000,
    statusCacheMs: 1_000,
    expected: expectedDeployment(environment),
  };
}
