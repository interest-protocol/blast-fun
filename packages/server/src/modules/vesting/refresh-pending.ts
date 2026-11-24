/** Refresh selected settlements with at most two active; stop starting work after cancellation. */
export async function refreshPendingVestings<T>(
  pending: readonly T[],
  refresh: (attempt: T) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (!signal?.aborted && next < pending.length) {
      const attempt = pending[next++]!;
      try {
        await refresh(attempt);
      } catch {
        // A failed refresh must not prevent the remaining settlements or the read.
      }
    }
  }
  await Promise.all([worker(), worker()]);
}
