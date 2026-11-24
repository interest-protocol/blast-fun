import assert from "node:assert/strict";
import test from "node:test";

import { keepAnchorInView } from "./anchor-keeper.ts";

/** Ports driven by the test: layout changes, reader input and the settle timer fire on demand. */
function harness() {
  const events: string[] = [];
  let layout: (() => void) | null = null;
  let reader: (() => void) | null = null;
  let timer: (() => void) | null = null;
  return {
    events,
    layoutChanges: () => layout?.(),
    readerMoves: () => reader?.(),
    settle: () => timer?.(),
    ports: {
      scroll: () => events.push("scroll"),
      onLayoutChange: (listener: () => void) => {
        layout = listener;
        return () => {
          events.push("layout off");
          layout = null;
        };
      },
      onReaderInput: (listener: () => void) => {
        reader = listener;
        return () => {
          events.push("reader off");
          reader = null;
        };
      },
      setTimer: (callback: () => void, ms: number) => {
        events.push(`timer ${ms}`);
        timer = callback;
        return () => {
          timer = null;
        };
      },
    },
  };
}

test("a durable link's record is brought into view, and again each time content above it loads", () => {
  const page = harness();
  keepAnchorInView(page.ports);
  assert.deepEqual(page.events, ["timer 15000", "scroll"]);
  page.layoutChanges(); // the Theses list answers above Activity on mobile
  page.layoutChanges();
  assert.deepEqual(page.events.filter((event) => event === "scroll").length, 3);
});

test("once the reader scrolls, taps or types, the page stops moving under them", () => {
  const page = harness();
  keepAnchorInView(page.ports);
  page.readerMoves();
  assert.ok(page.events.includes("layout off") && page.events.includes("reader off"));
  page.layoutChanges();
  assert.equal(page.events.filter((event) => event === "scroll").length, 1);
});

test("it settles after its window, and stopping it releases every listener", () => {
  const settled = harness();
  keepAnchorInView(settled.ports, 5_000);
  assert.ok(settled.events.includes("timer 5000"));
  settled.settle();
  settled.layoutChanges();
  assert.equal(settled.events.filter((event) => event === "scroll").length, 1);

  const stopped = harness();
  const stop = keepAnchorInView(stopped.ports);
  stop();
  stopped.layoutChanges();
  assert.equal(stopped.events.filter((event) => event === "scroll").length, 1);
  assert.ok(stopped.events.includes("layout off") && stopped.events.includes("reader off"));
});
