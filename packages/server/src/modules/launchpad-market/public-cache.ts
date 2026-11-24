import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { MARKET_BODY_LIMIT_BYTES, type MarketTextResponse, type MarketUpstream } from "@blast/server/modules/launchpad-market/routes.ts";
import { readBoundedText } from "@blast/server/lib/web-security/request-body.ts";

type PublicRead = <T>(key: string, load: () => Promise<T>, cacheMs: number) => Promise<T>;
const MAX_CACHED_BODY_BYTES = 256 * 1_024;

/** Private fields keep provider bodies out of serialized errors and metrics. */
class UncachedResponseDefinition extends Error {
  readonly #reply: MarketTextResponse;

  constructor(reply: MarketTextResponse) {
    super("Market response is not cacheable");
    this.#reply = reply;
  }

  reply(): MarketTextResponse {
    return { ...this.#reply };
  }
}

// Next bundles share in-flight reads, including the exceptions carrying an
// uncached response. They must agree on the constructor used by instanceof.
const UncachedResponse = processSingleton("market.uncached-response", () => UncachedResponseDefinition);

/** Share successful public market data, never credentials, readiness or errors. */
export function cachedMarketUpstream(upstream: MarketUpstream, publicRead: PublicRead): MarketUpstream {
  const origin = new URL(upstream.origin).origin;
  function cacheKey(input: RequestInfo | URL, init?: RequestInit): string | null {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    return method === "GET" && url.origin === origin && /^\/v1\/(?:pools|coins|launches)\//.test(url.pathname) ? url.href : null;
  }

  async function source(input: RequestInfo | URL, init?: RequestInit): Promise<MarketTextResponse> {
    // Runtime callers supply a service deadline, not a browser disconnect signal:
    // one visitor must not cancel every coalesced caller's read.
    const response = await upstream.fetch(input, init);
    const text = await readBoundedText(response, MARKET_BODY_LIMIT_BYTES);
    if (text === null) throw new RangeError("Market body exceeds the read limit");
    return { status: response.status, text };
  }

  async function readText(input: RequestInfo | URL, init?: RequestInit): Promise<MarketTextResponse> {
    const key = cacheKey(input, init);
    if (!key) return source(input, init);
    try {
      const text = await publicRead(key, async () => {
        const reply = await source(input, init);
        if (reply.status !== 200 || Buffer.byteLength(reply.text) > MAX_CACHED_BODY_BYTES) throw new UncachedResponse(reply);
        try { JSON.parse(reply.text); }
        catch { throw new UncachedResponse(reply); }
        return reply.text;
      }, 5_000);
      return { status: 200, text };
    } catch (error) {
      if (error instanceof UncachedResponse) return error.reply();
      throw error;
    }
  }

  return {
    origin: upstream.origin,
    readText,
    async fetch(input, init) {
      if (!cacheKey(input, init)) return upstream.fetch(input, init);
      const { status, text } = await readText(input, init);
      return new Response(text || null, {
        status,
        ...(status === 200 ? { headers: { "Content-Type": "application/json" } } : {}),
      });
    },
  };
}
