/** Concurrent callers for the same key share one in-flight operation. */
export class SingleFlight<Value> {
  readonly #pending = new Map<string, Promise<Value>>();

  run(
    key: string,
    operation: () => Promise<Value>,
  ): Readonly<{ promise: Promise<Value>; shared: boolean }> {
    const pending = this.#pending.get(key);
    if (pending) return { promise: pending, shared: true };
    const promise = operation().finally(() => {
      this.#pending.delete(key);
    });
    this.#pending.set(key, promise);
    return { promise, shared: false };
  }
}
