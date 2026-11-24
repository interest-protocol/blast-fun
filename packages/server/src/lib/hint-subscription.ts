export type HintSink = Readonly<{
  send(chunk: Uint8Array): boolean;
  close(): void;
}>;

export type HintSubscription = Response | (() => void) | null;

export function hintWebResponse(
  signal: AbortSignal,
  subscribe: (sink: HintSink) => HintSubscription,
  headers: HeadersInit,
  strategy: QueuingStrategy<Uint8Array>,
): Response {
  const result: { subscription?: HintSubscription } = {};
  const stop = () => {
    if (typeof result.subscription === "function") result.subscription();
  };
  let cancelled = false;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      result.subscription = subscribe({
        send(chunk) {
          const size = strategy.size?.(chunk) ?? 1;
          if ((controller.desiredSize ?? 0) < size) return false;
          controller.enqueue(chunk);
          return true;
        },
        close() {
          closed = true;
          signal.removeEventListener("abort", stop);
          if (!cancelled) controller.close();
        },
      });
      if (typeof result.subscription !== "function") controller.close();
      else if (!closed) signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      cancelled = true;
      stop();
    },
  }, strategy);
  return result.subscription instanceof Response ? result.subscription : new Response(body, { headers });
}
