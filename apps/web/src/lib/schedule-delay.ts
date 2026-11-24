/** Schedule a single task and return its cancellation callback. */
export function scheduleDelay(run: () => void, delay: number): () => void {
  const timer = setTimeout(run, delay);
  return () => clearTimeout(timer);
}
