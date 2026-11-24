import { mock } from "node:test";

const nativeTimeout = globalThis.setTimeout;

/** Run real timeout callbacks promptly while keeping their requested delays observable. */
export function fastTimeouts(record: (ms: number) => void = () => undefined): void {
  mock.method(globalThis, "setTimeout", ((run: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    record(ms ?? 0);
    return nativeTimeout(run, 0, ...args);
  }) as typeof setTimeout);
}
