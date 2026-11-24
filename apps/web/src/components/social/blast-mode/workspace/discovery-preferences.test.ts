import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DISCOVERY,
  discoveryPreferences,
  discoveryKindVisible,
} from "./discovery-preferences";
import {
  ActivityCursorError,
  activityStreamQuery,
} from "./activity-stream-query";

test("discovery preferences recover corrupt storage and preserve explicit false filters", () => {
  for (const raw of [null, "", "{", "null", "[]", '{"source":"friends"}'])
    assert.deepEqual(discoveryPreferences(raw), DEFAULT_DISCOVERY);
  assert.deepEqual(
    discoveryPreferences(
      '{"source":"recent","buy":false,"sell":"no","presale":false}',
    ),
    { source: "recent", buy: false, sell: true, presale: false },
  );
  const filtered = { ...DEFAULT_DISCOVERY, buy: false, presale: false };
  assert.equal(discoveryKindVisible("trade_buy", filtered), false);
  assert.equal(discoveryKindVisible("trade_sell", filtered), true);
  assert.equal(discoveryKindVisible("presale_commit", filtered), false);
  assert.equal(discoveryKindVisible("presale_claim", filtered), false);
});

test("the shared public activity query keeps cursor identity, cancellation, and expired-cursor errors", async () => {
  const original = globalThis.fetch;
  const signal = new AbortController().signal;
  const options = activityStreamQuery("24h", 20, "next+/=");
  assert.deepEqual(options.queryKey, [
    "blast",
    "public",
    "workspace-activity",
    "24h",
    20,
    "next+/=",
  ]);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://blast.test");
    assert.equal(url.searchParams.get("cursor"), "next+/=");
    assert.equal(init?.signal, signal);
    return Response.json({ error: { parameter: "cursor" } }, { status: 400 });
  };
  try {
    const run = options.queryFn as (context: {
      signal: AbortSignal;
    }) => Promise<unknown>;
    await assert.rejects(run({ signal }), ActivityCursorError);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(run({ signal }), /Activity could not load/);
  } finally {
    globalThis.fetch = original;
  }
});

test("activity response boundary rejects malformed nested events and retains empty windows", async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const options = activityStreamQuery("24h");
  const run = options.queryFn as (context: { signal: AbortSignal }) => Promise<unknown>;
  const signal = new AbortController().signal;
  const page = { window: "24h", from_ms: -1, to_ms: 0, clock_ms: 0, events: [], next_cursor: null, as_of: { checkpoint: 0, timestamp_ms: 0, lag_ms: 0 } };
  globalThis.fetch = async () => Response.json(page);
  assert.deepEqual(await run({ signal }), page);
  globalThis.fetch = async () => Response.json({ ...page, events: [{}] });
  await assert.rejects(run({ signal }), /Activity response is incomplete/);
});
