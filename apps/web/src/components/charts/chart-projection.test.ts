import assert from "node:assert/strict";
import test from "node:test";
import { chartProjectionQueue } from "./chart-projection.ts";

test("an idle projection waits for a new candle's native draw and runs in the same frame", () => {
  let id = 0;
  const queued = new Map<number, FrameRequestCallback>();
  const frames = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      queued.set(++id, callback);
      return id;
    },
    cancelAnimationFrame(key: number) { queued.delete(key); },
  };
  const calls: string[] = [];
  const projection = chartProjectionQueue(() => calls.push("project"), frames);
  projection.schedule(); // A wheel event, before the trade.
  frames.requestAnimationFrame(() => {
    calls.push("draw candle");
    projection.schedule(); // The chart publishes its adjusted range inside the draw.
  });
  projection.afterChartWrite();
  const frame = [...queued.values()];
  queued.clear();
  for (const callback of frame) callback(16);
  assert.deepEqual(calls, ["draw candle", "project"]);
  assert.equal(queued.size, 0);
  projection.schedule();
  projection.cancel();
  assert.equal(queued.size, 0);
});
