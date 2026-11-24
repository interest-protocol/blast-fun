import { z } from "zod";
import { aggregateSnapshotV3 } from "../generated/aggregate-contract.ts";
import { upstreamEndpoint } from "./summary.ts";

export const accountSummaryEnvelope = aggregateSnapshotV3.extend({
  generatedAt: z.iso.datetime(),
  chainStale: z.boolean(),
  accountStale: z.boolean(),
  stale: z.boolean(),
});
export type AccountSummary = z.infer<typeof accountSummaryEnvelope> & {
  deliveryDegraded?: true;
};

/** This server-only consumer is dormant; the dashboard keeps its version 2 reader/UI. */
export function createAccountSummaryReader(
  value: string,
  token: string,
  options: {
    enabled?: boolean;
    fetcher?: typeof fetch;
    now?: () => number;
    development?: boolean;
    timeoutMs?: number;
  } = {},
) {
  if (options.enabled !== true) {
    return null;
  }
  const endpoint = upstreamEndpoint(value, options.development);
  endpoint.pathname = "/v3/summary";
  if (token.length < 32 || token.length > 4096 || /\s/.test(token)) {
    throw new Error("Invalid private analytics API configuration");
  }
  const timeout = options.timeoutMs ?? 3000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3000) {
    throw new Error("Invalid private analytics API deadline");
  }
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { data: AccountSummary; at: number } | undefined;
  let pending: Promise<AccountSummary> | undefined;

  function freshness(data: AccountSummary, degraded = false): AccountSummary {
    const clock = BigInt(now());
    const generated = BigInt(Date.parse(data.generatedAt));
    const old = (cut: bigint) => cut > clock || clock - cut > 3600000n;
    const chainStale =
      data.chainStale ||
      old(BigInt(data.asOfTimestampMs)) ||
      old(BigInt(data.chainPublicationTimestampMs)) ||
      old(generated);
    const accountStale =
      data.accountStale ||
      old(BigInt(data.accountObservationTimestampMs)) ||
      old(generated);
    return {
      ...data,
      chainStale,
      accountStale,
      stale: data.stale || chainStale || accountStale || degraded,
      ...(degraded ? { deliveryDegraded: true as const } : {}),
    };
  }

  return async (): Promise<AccountSummary> => {
    if (cached && now() - cached.at < 60000) {
      return freshness(cached.data);
    }
    if (pending) {
      return pending;
    }
    pending = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Snapshot unavailable"));
          }, timeout);
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
            Number(response.headers.get("content-length") ?? 0) > 1000000
          ) {
            throw new Error();
          }
          reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const chunk = await reader.read();
            controller.signal.throwIfAborted();
            if (chunk.done) {
              break;
            }
            size += chunk.value.byteLength;
            if (size > 1000000) {
              throw new Error();
            }
            chunks.push(chunk.value);
          }
          return accountSummaryEnvelope.parse(
            JSON.parse(Buffer.concat(chunks, size).toString("utf8")),
          );
        };
        const data = await Promise.race([read(), deadline]);
        cached = { data, at: now() };
        return freshness(data);
      } catch {
        controller.abort();
        if (!cached || now() - cached.at >= 86400000) {
          throw new Error("Snapshot unavailable");
        }
        return freshness(cached.data, true);
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
