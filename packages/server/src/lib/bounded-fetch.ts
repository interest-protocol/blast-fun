import { requestWorkSignal } from "./request-work.ts";

/** Abort the underlying fetch, including response-body reads, rather than race a detached task. */
export function boundedFetch(
  timeoutMs: number,
  transport: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new TypeError("Invalid fetch deadline.");
  return Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const inherited =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const timeout = AbortSignal.timeout(timeoutMs);
      const absolute = requestWorkSignal();
      const signals = [timeout];
      if (inherited) signals.push(inherited);
      if (absolute) signals.push(absolute);
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      return transport(input, { ...init, signal });
    },
    transport,
  );
}
