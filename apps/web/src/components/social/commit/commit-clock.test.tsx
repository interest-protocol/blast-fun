import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const dom = installTestDom();
let visibility: DocumentVisibilityState = "visible";
Object.defineProperty(dom.document, "visibilityState", { get: () => visibility, configurable: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useCommitClock } = await import("./commit-clock");

const START = 1_000_000;

/** A reader that records the time it drew, once per draw. */
function Reader({ drawn, running }: Readonly<{ drawn: number[]; running?: boolean }>) {
  drawn.push(useCommitClock(running));
  return null;
}

function mount(t: TestContext) {
  const root = createRoot(dom.document.createElement("div"));
  t.after(async () => { await act(async () => root.unmount()); });
  return root;
}

const pass = (t: TestContext, ms: number) => act(async () => { t.mock.timers.tick(ms); });
const show = (state: DocumentVisibilityState) => act(async () => { visibility = state; dom.document.dispatchEvent(new dom.window.Event("visibilitychange")); });

test("a hidden tab is not redrawn by the clock, which shows the right time at once on return", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START });
  const drawn: number[] = [];
  const root = mount(t);
  await act(async () => root.render(<Reader drawn={drawn} />));
  await pass(t, 1_000);
  assert.equal(drawn.at(-1), START + 1_000);
  await show("hidden");
  const draws = drawn.length;
  await pass(t, 60_000);
  assert.equal(drawn.length, draws);
  await show("visible");
  assert.equal(drawn.at(-1), START + 61_000);
  await pass(t, 1_000);
  assert.equal(drawn.at(-1), START + 62_000);
});

test("a clock that is not running draws nothing, and its first draw once running has the current time", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START + 100_000 });
  const drawn: number[] = [];
  const root = mount(t);
  await act(async () => root.render(<Reader drawn={drawn} running={false} />));
  await pass(t, 30_000);
  assert.deepEqual(drawn, [0]);
  await act(async () => root.render(<Reader drawn={drawn} running />));
  assert.equal(drawn[1], START + 130_000);
});

test("the clock keeps ticking for the readers that remain when another leaves", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: START + 200_000 });
  const staying: number[] = [];
  const root = mount(t);
  await act(async () => root.render(<><Reader key="staying" drawn={staying} /><Reader key="leaving" drawn={[]} /></>));
  await act(async () => root.render(<><Reader key="staying" drawn={staying} /></>));
  await pass(t, 2_000);
  assert.equal(staying.at(-1), START + 202_000);
});
