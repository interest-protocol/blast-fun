/** Align overlays with the native chart's draw when a write changes its scale. */
export function chartProjectionQueue(project: () => void, frames: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame"> = window) {
  let pending: number | null = null;
  function cancel() {
    if (pending !== null) frames.cancelAnimationFrame(pending);
    pending = null;
  }
  function schedule() {
    if (pending !== null) return;
    pending = frames.requestAnimationFrame(() => {
      pending = null;
      project();
    });
  }
  function afterChartWrite() {
    // A pointer event may already have queued a projection before the native draw.
    // Put it behind that draw. Range notifications during the draw reuse this slot.
    cancel();
    schedule();
  }
  return { schedule, afterChartWrite, cancel };
}
