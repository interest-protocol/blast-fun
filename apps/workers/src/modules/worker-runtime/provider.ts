// Bounded provider calls. Every Sui node call the worker makes goes through
// `bounded`: it gets an abort signal and is abandoned at its budget even when
// the transport ignores the signal. Nothing here retries: a failed call ends
// the record's pass, and the record's backoff (after a fresh reconciliation)
// is the only retry layer.

/** A provider call failed or ran past its budget. Its message never carries the provider's answer. */
export class ProviderUnavailable extends Error {
  readonly code = "provider-unavailable";

  constructor(reason: "timeout" | "error") {
    super(reason === "timeout" ? "The Sui node did not answer in time." : "The Sui node call failed.");
    this.name = "ProviderUnavailable";
  }
}

export async function bounded<Result>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderUnavailable("timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof ProviderUnavailable) throw error;
    throw new ProviderUnavailable(controller.signal.aborted ? "timeout" : "error");
  } finally {
    clearTimeout(timer);
  }
}

/** A Sui node call runner: every worker read goes through one. */
export type Provider = <Result>(call: (signal: AbortSignal) => Promise<Result>) => Promise<Result>;

/** A `Provider` that runs each call through `bounded(timeoutMs)`. */
export function boundedProvider(timeoutMs: number): Provider {
  return (call) => bounded(timeoutMs, call);
}
