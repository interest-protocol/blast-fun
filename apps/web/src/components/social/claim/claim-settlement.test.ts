import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { ActivityHints } from "../home/activity-hints.ts";
import type { FreshnessSignal } from "../home/feed-freshness.ts";
import { createClaimRunner } from "./claim-runner.ts";
import { watchClaimReads } from "./claim-refresh.ts";
import { watchClaimSettlement } from "./claim-settlement.ts";

installTestDom();
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a live activity hint rereads private claim state and stops once inclusion is observed", async (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: class {}, configurable: true, writable: true });
  let signal: FreshnessSignal | undefined;
  let stopped = false;
  t.mock.method(ActivityHints.prototype, "subscribe", (_name: string, next: FreshnessSignal) => {
    signal = next;
    return () => { stopped = true; };
  });
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, retry: false } } });
  const runner = createClaimRunner(async () => ({ status: "confirmed", digest: "digest" }));
  const query = new QueryObserver(client, {
    queryKey: queryKeys.me.portfolio(),
    initialData: { positions: [] as { presale_id: string; status: string }[] },
    staleTime: Infinity,
    queryFn: async () => ({ positions: [{ presale_id: "sale", status: "delivered" }] }),
  });
  const off = query.subscribe(() => undefined);
  const stop = watchClaimReads(runner, client);
  try {
    runner.run({ key: "tokens:sale", presaleId: "sale", kind: "claim_tokens", done: { title: "Claimed", sub: "Sale" } });
    await tick();
    assert.equal(runner.pending().size, 1);
    signal?.({ atMs: Date.now(), cause: "hint" });
    await tick();
    assert.equal(runner.pending().size, 0);
    assert.equal(stopped, true, "private inclusion releases the live subscription");
    assert.equal(runner.view("tokens:sale").state, "done");
  } finally {
    stop();
    off();
    client.clear();
    if (before) Object.defineProperty(globalThis, "WebSocket", before);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

test("unmount cancels the fallback and an already queued live refresh", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const before = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: class {}, configurable: true, writable: true });
  let signal: FreshnessSignal | undefined;
  t.mock.method(ActivityHints.prototype, "subscribe", (_name: string, next: FreshnessSignal) => {
    signal = next;
    return () => undefined;
  });
  let reads = 0;
  const cancel = t.mock.method(globalThis, "clearTimeout");
  try {
    const stop = watchClaimSettlement(() => { reads++; });
    signal?.({ atMs: 0, cause: "hint" });
    stop();
    assert.equal(cancel.mock.calls.length, 1, "unmount releases its fallback timer");
    t.mock.timers.tick(18_000);
    await tick();
    assert.equal(reads, 0);
  } finally {
    if (before) Object.defineProperty(globalThis, "WebSocket", before);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  }
});
