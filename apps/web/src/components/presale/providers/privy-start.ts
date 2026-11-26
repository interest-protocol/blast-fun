import type { PrivyRuntime } from "#web/components/auth/privy-session.ts";

export type PrivyStartState = Readonly<{
  /** Privy's runtime once it is ready; null before that and after it stops. */
  runtime: PrivyRuntime | null;
  /** The last start failed; the SDK stays unmounted until the next `wait`. */
  failed: boolean;
  /** Counts starts, so each retry mounts a fresh SDK. */
  attempt: number;
}>;

/**
 * One page's Privy start, owned by `PrivySessionProvider`. The lazily loaded
 * runtime writes to it (`publish`, `fail`); the provider reads it with
 * `useSyncExternalStore`, and `load` callers wait on it.
 */
export class PrivyStart {
  #state: PrivyStartState = { runtime: null, failed: false, attempt: 0 };
  #listeners = new Set<() => void>();
  #waiting = new Set<Readonly<{ resolve: (runtime: PrivyRuntime) => void; reject: (error: Error) => void }>>();
  #stopped = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  readonly state = (): PrivyStartState => this.#state;

  /** Resolves once Privy is ready. After a failed start, `retry` runs and a fresh SDK mounts. */
  wait(retry: () => void): Promise<PrivyRuntime> {
    if (this.#stopped) return Promise.reject(new Error("Privy stopped."));
    const { runtime, failed, attempt } = this.#state;
    if (runtime) return Promise.resolve(runtime);
    if (failed) {
      retry();
      this.#set({ runtime: null, failed: false, attempt: attempt + 1 });
    }
    return new Promise((resolve, reject) => this.#waiting.add({ resolve, reject }));
  }

  /** Privy is ready (its runtime) or has stopped (null). A failed start's SDK is unmounting, so its late ready is ignored. */
  publish(runtime: PrivyRuntime | null): void {
    if (this.#state.runtime === runtime || (runtime && this.#state.failed)) return;
    this.#set({ ...this.#state, runtime });
    if (runtime) this.#settle((waiter) => waiter.resolve(runtime));
  }

  /** Privy did not start: every waiting `load` rejects, and the next one retries. */
  fail(): void {
    if (this.#state.failed) return;
    this.#set({ ...this.#state, runtime: null, failed: true });
    this.#settle((waiter) => waiter.reject(new Error("Privy did not start. Try again.")));
  }

  /** The provider mounted (again, under Strict Mode); returns its unmount. */
  mount(): () => void {
    this.#stopped = false;
    return () => this.stop();
  }

  /** The provider unmounted: nothing will answer the waiting `load` calls, or later ones. */
  stop(): void {
    this.#stopped = true;
    this.#settle((waiter) => waiter.reject(new Error("Privy stopped.")));
  }

  #set(state: PrivyStartState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }

  #settle(answer: (waiter: Readonly<{ resolve: (runtime: PrivyRuntime) => void; reject: (error: Error) => void }>) => void): void {
    for (const waiter of this.#waiting) answer(waiter);
    this.#waiting.clear();
  }
}
