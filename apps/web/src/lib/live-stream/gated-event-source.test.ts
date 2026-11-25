import assert from "node:assert/strict";
import test from "node:test";

import { gatedEventSource, type GatedEventSourceDependencies } from "#web/lib/live-stream/gated-event-source.ts";

const CONNECTING = 0;
const CLOSED = 2;

class FakeSource extends EventTarget {
  readyState = CONNECTING;
  closed = false;
  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }
  /** The browser's view of a refused open (401, 503): an error with the source already CLOSED. */
  refuse(): void {
    this.readyState = CLOSED;
    this.dispatchEvent(new Event("error"));
  }
}

function harness(refreshes: boolean[]) {
  const sources: FakeSource[] = [];
  let refreshCalls = 0;
  let settle: (() => void) | null = null;
  const deps: GatedEventSourceDependencies = {
    create: (url) => {
      assert.equal(url, "/api/stream");
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
    refresh: () => {
      refreshCalls += 1;
      const renewed = refreshes.shift() ?? false;
      return new Promise((resolve) => { settle = () => resolve(renewed); });
    },
  };
  const ends: string[] = [];
  const frames: string[] = [];
  const stream = gatedEventSource("/api/stream", deps);
  stream.addEventListener("error", () => ends.push("error"));
  stream.addEventListener("refused", () => ends.push("refused"));
  stream.addEventListener("market", (event) => frames.push(String((event as MessageEvent).data)));
  const flush = async () => {
    settle?.();
    settle = null;
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { stream, sources, ends, frames, flush, refreshCalls: () => refreshCalls };
}

test("a refused open refreshes the gate once and the reopened stream keeps its listeners", async () => {
  const h = harness([true]);
  h.sources[0].refuse();
  assert.equal(h.sources[0].closed, true, "the refused source is closed before the refresh");
  await h.flush();
  assert.equal(h.refreshCalls(), 1);
  assert.equal(h.sources.length, 2, "one reopen with the new cookie");
  h.sources[1].dispatchEvent(new Event("open"));
  h.sources[1].dispatchEvent(new MessageEvent("market", { data: "frame" }));
  assert.deepEqual(h.frames, ["frame"]);
  assert.deepEqual(h.ends, [], "the caller never saw the refusal");
});

test("a failed gate refresh ends the stream as refused without reopening", async () => {
  const h = harness([false]);
  h.sources[0].refuse();
  await h.flush();
  assert.equal(h.sources.length, 1);
  assert.deepEqual(h.ends, ["refused"]);
});

test("a second refusal after the refresh ends as refused: one refresh, never a loop", async () => {
  const h = harness([true, true]);
  h.sources[0].refuse();
  await h.flush();
  h.sources[1].refuse();
  await h.flush();
  assert.equal(h.refreshCalls(), 1);
  assert.equal(h.sources.length, 2);
  assert.deepEqual(h.ends, ["refused"]);
});

test("a drop after the stream opened is an error for the caller's backoff, with no refresh", async () => {
  const h = harness([true]);
  h.sources[0].dispatchEvent(new Event("open"));
  h.sources[0].refuse();
  await h.flush();
  assert.equal(h.refreshCalls(), 0);
  assert.deepEqual(h.ends, ["error"]);
});

test("an error while the browser retries (not CLOSED) is an error, with no refresh", async () => {
  const h = harness([true]);
  h.sources[0].dispatchEvent(new Event("error"));
  await h.flush();
  assert.equal(h.refreshCalls(), 0);
  assert.deepEqual(h.ends, ["error"]);
});

test("closing during the refresh opens nothing and reports nothing", async () => {
  const h = harness([true]);
  h.sources[0].refuse();
  h.stream.close();
  await h.flush();
  assert.equal(h.sources.length, 1);
  assert.deepEqual(h.ends, []);
});
