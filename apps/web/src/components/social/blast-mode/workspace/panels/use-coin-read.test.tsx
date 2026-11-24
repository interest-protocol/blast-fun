import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { startWorkspaceLiveRead } from "../live-read";
import { WorkspaceLiveProvider } from "../live-clock";
import { handClock } from "../../../../../../test/fixtures/workspace/live-clock";
import { useCoinRead } from "./use-coin-read";

test("a presented read recurs, ignores hidden answers and waits for new facts when presented again", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const time = handClock();
  const requests: { signal: AbortSignal; answer: (value: string) => void }[] = [];
  const read = (signal: AbortSignal) => new Promise<string>((answer) => requests.push({ signal, answer }));
  const received: string[] = [];
  function Subject({ active }: Readonly<{ active: boolean }>) {
    const result = useCoinRead(active, "coin:A", read, value => received.push(value));
    return <output>{result.status}:{result.value}</output>;
  }
  const render = async (active: boolean) => {
    await act(async () => root.render(<WorkspaceLiveProvider clock={time.clock}><Subject active={active} /></WorkspaceLiveProvider>));
  };
  try {
    await render(true);
    await act(async () => requests[0]!.answer("first"));
    assert.equal(document.querySelector("output")!.textContent, "ready:first");
    assert.deepEqual(received, ["first"]);
    await act(async () => time.advance(15_000));
    assert.equal(requests.length, 2);
    await render(false);
    assert.equal(requests[1]!.signal.aborted, true);
    await act(async () => requests[1]!.answer("late hidden"));
    assert.equal(document.querySelector("output")!.textContent, "pending:");
    assert.deepEqual(received, ["first"], "late hidden answers cannot trigger lifecycle actions");
    await render(true);
    assert.equal(document.querySelector("output")!.textContent, "pending:", "stale data cannot enable an action on return");
    assert.equal(requests.length, 3);
    await act(async () => requests[2]!.answer("fresh return"));
    assert.equal(document.querySelector("output")!.textContent, "ready:fresh return");
    assert.deepEqual(received, ["first", "fresh return"]);
    await render(true);
    assert.equal(requests.length, 3, "new callback identity does not restart the read");
    assert.deepEqual(received, ["first", "fresh return"], "rendering cannot replay successful read events");
  } finally {
    await act(async () => root.unmount());
    assert.equal(time.timers.size, 0);
    dom.window.close();
  }
});


test("successful reads check old observations without replacing their time and failed checks have no success time", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const time = handClock(200_000);
  let fail = false;
  const read = async () => {
    if (fail) throw new Error("offline");
    return { holders_as_of_ms: 1_000, price_as_of_ms: 2_000 };
  };
  function Subject() {
    const result = useCoinRead(true, "coin:A", read);
    return <output>{JSON.stringify(result)}</output>;
  }
  const result = () => JSON.parse(document.querySelector("output")!.textContent!);
  try {
    await act(async () => root.render(<WorkspaceLiveProvider clock={time.clock}><Subject /></WorkspaceLiveProvider>));
    assert.equal(result().checkedAt, 200_000);
    assert.deepEqual(result().value, { holders_as_of_ms: 1_000, price_as_of_ms: 2_000 });
    await act(async () => time.advance(15_000));
    assert.equal(result().checkedAt, 215_000);
    assert.deepEqual(result().value, { holders_as_of_ms: 1_000, price_as_of_ms: 2_000 });
    fail = true;
    await act(async () => time.advance(15_000));
    assert.equal(result().status, "error");
    assert.equal(result().checkedAt, null);
  } finally {
    await act(async () => root.unmount());
    assert.equal(time.timers.size, 0);
    dom.window.close();
  }
});

test("a one-shot read receives the result without starting a poll", async () => {
  const { clock, timers } = handClock();
  const answer = Promise.withResolvers<string>();
  const seen: unknown[] = [];
  const dispose = startWorkspaceLiveRead({
    clock,
    intervalMs: null,
    read: () => answer.promise,
    receive: (value) => seen.push(value),
  });
  try {
    answer.resolve("coin metadata");
    await answer.promise;
    assert.deepEqual(seen, [{ status: "ready", value: "coin metadata" }]);
    assert.equal(timers.size, 0);
  } finally {
    dispose();
  }
});
