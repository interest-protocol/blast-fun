import assert from "node:assert/strict";
import test from "node:test";

import { ActivityHintRelay, type RelaySocket } from "@blast/server/modules/social/activity/hint-relay.ts";
import { infraProvenanceFixture } from "../../../../test/fixtures/modules/launchpad-contract/fixtures.ts";

test("all connected streams share one heartbeat timer until the last cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const intervals = t.mock.method(globalThis, "setInterval");
  const cleared = t.mock.method(globalThis, "clearInterval");
  let closed = 0;
  const socket = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null, onerror: null,
    send() {},
    close() { closed += 1; },
  } satisfies RelaySocket;
  const relay = new ActivityHintRelay(() => socket);
  const readers = Array.from({ length: 200 }, () => relay.stream(new Request("https://blast.test/api/social/activity/hints")).body!.getReader());
  try {
    socket.onmessage?.({ data: JSON.stringify({ type: "hello", protocol: 1, provenance: infraProvenanceFixture({ deployment_fingerprint: null }) }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "pong" }) });
    for (const reader of readers) {
      await reader.read();
      await reader.read();
    }
    assert.equal(intervals.mock.callCount(), 1);
    t.mock.timers.tick(15_000);
    for (const reader of readers) assert.equal(new TextDecoder().decode((await reader.read()).value), ": keepalive\n\n");
    await readers[0]!.cancel();
    assert.equal(cleared.mock.callCount(), 0);
    assert.equal(closed, 0);
    await Promise.all(readers.slice(1).map((reader) => reader.cancel()));
    assert.equal(cleared.mock.callCount(), 1);
    assert.equal(closed, 1);
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
  }
});

test("an old heartbeat cannot broadcast into a replacement connection generation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const intervals = t.mock.method(globalThis, "setInterval");
  const relay = new ActivityHintRelay(() => ({ onmessage: null, onclose: null, onerror: null, send() {}, close() {} }));
  const first = relay.stream(new Request("https://blast.test/api/social/activity/hints")).body!.getReader();
  const oldTick = intervals.mock.calls[0]!.arguments[0] as () => void;
  await first.cancel();
  const replacement = relay.stream(new Request("https://blast.test/api/social/activity/hints")).body!.getReader();
  try {
    oldTick();
    const read = replacement.read();
    await replacement.cancel();
    assert.deepEqual(await read, { done: true, value: undefined });
    assert.equal(intervals.mock.callCount(), 2);
  } finally {
    await replacement.cancel();
  }
});
