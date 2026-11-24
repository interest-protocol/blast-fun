import { trustedUrl } from "@blast/core/lib/config/trusted-origin.ts";
import { readBoundedText } from "@blast/server/lib/web-security/request-body.ts";

export type GasPoolHealth = Readonly<{
  up: boolean;
  version: string | null;
  latencyMs: number | null;
  checkedAt: string;
}>;

type Dependencies = Readonly<{
  origin: () => string | undefined;
  fetcher?: typeof fetch;
  now?: () => number;
  allowLocalHttp?: boolean;
}>;
const HEADERS = { "Cache-Control": "no-store" };
const TIMEOUT_MS = 3_000;

/** An oversized or malformed body fails the check, as a network error does. */
async function boundedText(response: Response, limit: number): Promise<string> {
  const text = await readBoundedText(response, limit, { fatal: true });
  if (text === null) throw new Error("Invalid gas-pool response");
  return text;
}

async function checkGasPool(
  origin: URL,
  fetcher: typeof fetch,
  now: () => number,
): Promise<GasPoolHealth> {
  const started = now();
  const checkedAt = new Date(started).toISOString();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const options: RequestInit = { signal, redirect: "error", cache: "no-store" };
  try {
    const response = await fetcher(origin, options);
    const up =
      response.ok && (await boundedText(response, 256)).trim() === "OK";
    if (!response.ok) await response.body?.cancel();
    const latencyMs = Math.max(0, now() - started);
    let version: string | null = null;
    if (up) {
      try {
        const response = await fetcher(new URL("/version", origin), options);
        if (response.ok)
          version =
            (await boundedText(response, 1024)).trim().slice(0, 100) || null;
        else await response.body?.cancel();
      } catch {
        // The public health check remains authoritative when version metadata is unavailable.
      }
    }
    return { up, version, latencyMs, checkedAt };
  } catch {
    return { up: false, version: null, latencyMs: null, checkedAt };
  }
}

/** Checks public pool health for the operator. */
export function createAdminGasPoolHealthRoute(dependencies: Dependencies) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET")
      return new Response(null, {
        status: 405,
        headers: { ...HEADERS, Allow: "GET" },
      });
    if (new URL(request.url).search)
      return Response.json(
        { error: "Invalid query" },
        { status: 400, headers: HEADERS },
      );
    let origin: URL;
    try {
      origin = trustedUrl("PRESALE_GAS_POOL_URL", dependencies.origin(), {
        shape: "origin",
        http: dependencies.allowLocalHttp === true ? "loopback" : "never",
      });
    } catch {
      return Response.json(
        { error: "Gas pool health is not configured" },
        { status: 503, headers: HEADERS },
      );
    }
    const health = await checkGasPool(
      origin,
      dependencies.fetcher ?? fetch,
      dependencies.now ?? Date.now,
    );
    return Response.json(health, { headers: HEADERS });
  };
}
