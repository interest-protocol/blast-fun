// Keep database work bounded and drain in-flight workers before the caller can
// close its pool on failure. Each worker schedules its next item after settling.
export async function forEachConcurrent(items, concurrency, operation) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Concurrency must be a positive integer.");
  }
  let next = 0;
  let failed = false;
  async function worker() {
    if (failed || next >= items.length) return;
    const index = next++;
    try {
      await operation(items[index], index);
    } catch (error) {
      failed = true;
      throw error;
    }
    return worker();
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
}
