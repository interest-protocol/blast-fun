import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";

import { createSearchClient } from "./search-client.ts";

test("shared searches abort the network only when their last reader leaves", { timeout: 1000 }, async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const calls: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const client = createSearchClient((_input, init) => new Promise((resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    calls.push({ signal, resolve });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), Date.now, cache);

  try {
    for (const read of [client.search.bind(client), client.coins.bind(client)]) {
      const first = new AbortController();
      const second = new AbortController();
      const before = calls.length;
      const abandoned = read("  NIM ", first.signal);
      const shared = read("nim", second.signal);
      assert.equal(calls.length, before + 1, "equivalent in-flight searches share a request");
      const call = calls.at(-1)!;
      first.abort();
      await abandoned;
      assert.equal(call.signal.aborted, false, "another reader still needs the response");
      second.abort();
      await shared;
      assert.equal(call.signal.aborted, true, "an unused request stops immediately");
      assert.equal(client.failure("nim"), undefined, "cancellation is not a search failure");
    }
  } finally {
    cache.clear();
  }
});

test("abandoning one search reader preserves the shared answer for the other", { timeout: 1000 }, async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  let finish: (response: Response) => void = () => assert.fail("request did not start");
  const client = createSearchClient(() => new Promise((resolve) => { finish = resolve; }), Date.now, cache);
  const controller = new AbortController();
  const answer = { query: "nim", presales: [], people: [], as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 } };
  try {
    const abandoned = client.search("nim", controller.signal);
    const remaining = client.search("nim");
    controller.abort();
    await abandoned;
    finish(Response.json(answer));
    assert.deepEqual(await remaining, answer);
    assert.deepEqual(client.remembered("nim"), answer);
  } finally {
    cache.clear();
  }
});

test("an already cancelled search does not start either endpoint", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  let calls = 0;
  const client = createSearchClient(async () => { calls++; return Response.json({}); }, Date.now, cache);
  const controller = new AbortController();
  controller.abort();
  try {
    assert.equal(await client.search("nim", controller.signal), null);
    assert.deepEqual(await client.coins("nim", controller.signal), []);
    assert.equal(calls, 0);
    assert.equal(client.failure("nim"), undefined);
  } finally {
    cache.clear();
  }
});
