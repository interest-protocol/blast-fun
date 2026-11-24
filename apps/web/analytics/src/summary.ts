import { z } from "zod";
import { aggregateSnapshot } from "../generated/aggregate-contract.ts";

export const summaryEnvelope = aggregateSnapshot.extend({
  generatedAt: z.iso.datetime(),
  stale: z.boolean(),
});
export type Summary = z.infer<typeof summaryEnvelope> & {
  deliveryDegraded?: true;
};
const MAX_BYTES = 1_000_000;
const MAX_AGE = 86_400_000;

export function upstreamEndpoint(value: string, development = false): URL {
  try {
    const url = new URL(value);
    const local =
      development &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      (!local && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      ![url.origin, `${url.origin}/`].includes(value)
    )
      throw new Error();
    return new URL("/v1/summary", url.origin);
  } catch {
    throw new Error("Invalid private analytics API configuration");
  }
}

function withFreshness(data: Summary, now: number, degraded = false): Summary {
  const asOf = BigInt(data.asOfTimestampMs);
  const generated = Date.parse(data.generatedAt);
  const stale =
    data.stale ||
    asOf > BigInt(now) ||
    BigInt(now) - asOf > 3_600_000n ||
    generated > now ||
    now - generated > 3_600_000;
  return {
    ...data,
    stale: stale || degraded,
    ...(degraded ? { deliveryDegraded: true as const } : {}),
  };
}

export function createSummaryReader(
  value: string,
  token: string,
  options: {
    fetcher?: typeof fetch;
    now?: () => number;
    development?: boolean;
    timeoutMs?: number;
  } = {},
) {
  const endpoint = upstreamEndpoint(value, options.development);
  if (token.length < 32 || token.length > 4096 || /\s/.test(token))
    throw new Error("Invalid private analytics API configuration");
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { data: Summary; at: number } | undefined;
  let pending: Promise<Summary> | undefined;
  return async (): Promise<Summary> => {
    if (cached && now() - cached.at < 60_000)
      return withFreshness(cached.data, now());
    if (pending) return pending;
    // A separate rejection bounds even a stalled custom stream; abort cancels real fetch/body I/O.
    pending = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Snapshot unavailable"));
          }, options.timeoutMs ?? 3000);
        });
        const read = async () => {
          const response = await fetcher(endpoint, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          if (
            !response.ok ||
            response.redirected ||
            !response.body ||
            Number(response.headers.get("content-length") ?? 0) > MAX_BYTES
          )
            throw new Error();
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const chunk = await reader.read();
            controller.signal.throwIfAborted();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_BYTES) throw new Error();
            chunks.push(chunk.value);
          }
          const body = Buffer.concat(chunks, size).toString("utf8");
          return summaryEnvelope.parse(JSON.parse(body));
        };
        const data = await Promise.race([read(), deadline]);
        cached = { data, at: now() };
        return withFreshness(data, now());
      } catch {
        controller.abort();
        if (!cached || now() - cached.at >= MAX_AGE)
          throw new Error("Snapshot unavailable");
        return withFreshness(cached.data, now(), true);
      } finally {
        clearTimeout(timer);
        void reader?.cancel().catch(() => {});
      }
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
