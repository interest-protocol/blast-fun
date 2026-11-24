import { spreadMs } from "#web/lib/query/polling.ts";

/** A known coverage gap is terminal until an explicit refresh or remount. */
export class WorkspaceDataUnavailable extends Error {}

/** The host's injectable clock also makes owned request/timer lifetimes observable. */
export type WorkspaceLiveClock = Readonly<{
  now: () => number;
  after: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}>;

export const workspaceLiveClock: WorkspaceLiveClock = {
  now: () => Date.now(),
  after: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type WorkspaceLiveResult<T> =
  | Readonly<{ status: "ready"; value: T }>
  | Readonly<{ status: "error"; value: null; unavailable?: boolean }>;

/** One immediate read, with polling when an interval is configured. */
export function startWorkspaceLiveRead<T>(options: Readonly<{
  clock: WorkspaceLiveClock;
  intervalMs: number | null | ((result: WorkspaceLiveResult<T>) => number | null);
  read: (signal: AbortSignal) => Promise<T>;
  receive: (result: WorkspaceLiveResult<T>) => void;
}>) {
  const controller = new AbortController();
  let timer: unknown;
  async function refresh() {
    let result: WorkspaceLiveResult<T>;
    try {
      result = { status: "ready", value: await options.read(controller.signal) };
    } catch (error) {
      result = { status: "error", value: null, ...(error instanceof WorkspaceDataUnavailable ? { unavailable: true } : {}) };
    }
    if (controller.signal.aborted) return;
    // The next read is armed before the answer is shown, so a receiver that throws cannot stop the poll.
    if (!(result.status === "error" && result.unavailable)) {
      // Spread by the answer's millisecond, so tabs that loaded together drift apart.
      const wait = typeof options.intervalMs === "function" ? options.intervalMs(result) : options.intervalMs;
      if (wait !== null) timer = options.clock.after(() => void refresh(), spreadMs(wait, options.clock.now()));
    }
    options.receive(result);
  }
  void refresh();
  return () => {
    controller.abort();
    options.clock.clear(timer);
  };
}
