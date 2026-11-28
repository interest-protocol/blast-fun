import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useBoundaryClock } = await import("./use-boundary-clock.ts");

const NOW = 1_791_000_000_000;

/** Draws the clock the hook answers and counts the renders it causes. */
async function probe(t: TestContext, atMs: number | null | undefined, nowMs = NOW) {
  const renders: number[] = [];
  function Probe({ at, now }: Readonly<{ at: number | null | undefined; now: number }>) {
    const clock = useBoundaryClock(at, now);
    renders.push(clock);
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (at: number | null | undefined, now: number) => act(async () => root.render(<Probe at={at} now={now} />));
  await render(atMs, nowMs);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  return { renders, render, unmount: () => act(async () => root.unmount()) };
}

const tick = (t: TestContext, ms: number) => act(async () => t.mock.timers.tick(ms));

test("the caller's clock until the time passes, then one render with the moment it did", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const { renders } = await probe(t, NOW + 5_000);
  assert.deepEqual(renders, [NOW]);
  await tick(t, 4_999);
  assert.deepEqual(renders, [NOW], "nothing ticks before the time");
  await tick(t, 1);
  assert.deepEqual(renders, [NOW, NOW + 5_000]);
  await tick(t, 60_000);
  assert.deepEqual(renders, [NOW, NOW + 5_000], "nothing ticks after it either");
});

test("a time already reached, or none, sets no timer; one the caller's clock is behind on catches up at once", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const setTimer = t.mock.method(globalThis, "setTimeout");
  for (const at of [NOW, NOW - 1, null, undefined]) {
    const { renders } = await probe(t, at);
    await tick(t, 60_000);
    assert.deepEqual(renders, [NOW]);
  }
  assert.equal(setTimer.mock.callCount(), 0);
  // The caller's clock is the server's, a minute old; the time between it and the browser's has passed.
  const browser = Date.now();
  const stale = await probe(t, browser - 10_000, browser - 60_000);
  await tick(t, 0);
  assert.deepEqual(stale.renders, [browser - 60_000, browser]);
});

test("unmounting clears the timer, and a new time arms its own", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const cleared = t.mock.method(globalThis, "clearTimeout");
  const { renders, render, unmount } = await probe(t, NOW + 5_000);
  await render(NOW + 9_000, NOW);
  await tick(t, 5_000);
  assert.deepEqual(renders, [NOW, NOW], "the first time's timer is gone");
  await tick(t, 4_000);
  assert.deepEqual(renders, [NOW, NOW, NOW + 9_000]);
  await render(NOW + 20_000, NOW);
  await unmount();
  assert.ok(cleared.mock.callCount() >= 2);
  await tick(t, 20_000);
  assert.equal(renders.length, 4, "nothing renders after unmount");
});

test("a time further ahead than one timeout holds waits again and passes on time", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const at = NOW + 60 * 86_400_000;
  const { renders } = await probe(t, at);
  await tick(t, 2_147_483_647);
  assert.deepEqual(renders, [NOW], "the longest timeout ends before the time: no render");
  await tick(t, at - NOW - 2_147_483_647);
  assert.deepEqual(renders, [NOW, at]);
});

test("a function of the clock names each next turn, one timeout at a time", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW });
  const renders: number[] = [];
  function Probe() {
    const clock = useBoundaryClock((at) => (at < NOW + 30_000 ? at + 10_000 : null), NOW);
    renders.push(clock);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); });
  await act(async () => root.render(<Probe />));
  await tick(t, 9_999);
  assert.deepEqual(renders, [NOW]);
  await tick(t, 1);
  await tick(t, 10_000);
  await tick(t, 10_000);
  await tick(t, 60_000);
  assert.deepEqual(renders, [NOW, NOW + 10_000, NOW + 20_000, NOW + 30_000], "the last turn names none");
});
