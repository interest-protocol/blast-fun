import assert from "node:assert/strict";
import { test } from "node:test";
import { createSummaryReader, upstreamEndpoint } from "./summary.ts";
import { envelope, now, token } from "../test/fixture.ts";
const fetcher = (run: () => Promise<Response>) => run as typeof fetch;
const readBody = (body: ReturnType<typeof envelope>) =>
  createSummaryReader("https://api.example", token, {
    now: () => now,
    fetcher: fetcher(async () => Response.json(body)),
  });

test("one upstream read serves concurrent callers, preserves exact values and recomputes source freshness in cache", async () => {
  let calls = 0,
    clock = now;
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  const read = createSummaryReader("https://api.example", token, {
    now: () => clock,
    fetcher: fetcher(async () => {
      calls++;
      return pending;
    }),
  });
  const first = read(),
    second = read();
  resolve(
    Response.json({ ...envelope(), asOfTimestampMs: String(now - 3_590_000) }),
  );
  assert.equal(
    (await first).volumeWindows["24h"].priced_usd,
    "9007199254740993.123456789012345678",
  );
  assert.equal((await second).stale, false);
  assert.equal(calls, 1);
  clock += 20_000;
  assert.equal((await read()).stale, true);
  assert.equal(calls, 1);
  assert.equal((await readBody({ ...envelope(), stale: true })()).stale, true);
  assert.equal(
    (await readBody({ ...envelope(), asOfTimestampMs: String(now) })()).stale,
    false,
  );
  assert.equal(
    (await readBody({ ...envelope(), asOfTimestampMs: String(now + 1) })())
      .stale,
    true,
  );
  assert.equal(
    (
      await readBody({
        ...envelope(),
        generatedAt: new Date(now + 1).toISOString(),
      })()
    ).stale,
    true,
  );
  assert.equal(
    (
      await readBody({
        ...envelope(),
        generatedAt: new Date(now - 3_600_001).toISOString(),
      })()
    ).stale,
    true,
  );
  assert.equal(
    (
      await readBody({
        ...envelope(),
        asOfTimestampMs: String(now - 3_600_000),
        generatedAt: new Date(now - 3_600_000).toISOString(),
      })()
    ).stale,
    false,
  );
});
test("last good data becomes explicitly degraded and expires after one day even when delivery fails", async () => {
  let clock = now,
    fail = false;
  const read = createSummaryReader("https://api.example", token, {
    now: () => clock,
    fetcher: fetcher(async () => {
      if (fail) throw new Error(token);
      return Response.json(envelope());
    }),
  });
  await read();
  fail = true;
  clock += 60_000;
  const result = await read();
  assert.equal(result.stale, true);
  assert.equal(result.deliveryDegraded, true);
  clock = now + 86_400_000;
  await assert.rejects(read(), { message: "Snapshot unavailable" });
});
test("streaming byte and deadline bounds refuse chunked oversized or stalled responses without exposing secrets", async () => {
  const oversized = createSummaryReader("https://api.example", token, {
    fetcher: fetcher(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // Valid JSON with trailing whitespace must fail because of the byte cap.
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(envelope())),
              );
              controller.enqueue(new TextEncoder().encode(" ".repeat(600_000)));
              controller.enqueue(new TextEncoder().encode(" ".repeat(600_000)));
              controller.close();
            },
          }),
        ),
    ),
  });
  await assert.rejects(oversized(), { message: "Snapshot unavailable" });
  const atLimit = createSummaryReader("https://api.example", token, {
    fetcher: fetcher(
      async () =>
        new Response(JSON.stringify(envelope()).padEnd(1_000_000, " ")),
    ),
  });
  assert.equal((await atLimit()).version, 2);
  const stalled = createSummaryReader("https://api.example", token, {
    timeoutMs: 20,
    fetcher: fetcher(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"secret":"'));
            },
          }),
        ),
    ),
  });
  await assert.rejects(stalled(), { message: "Snapshot unavailable" });
});
test("strict envelopes reject version, unknown-field and numeric-money drift before caching", async () => {
  let body: unknown = { ...envelope(), privateWallet: "secret" };
  const read = createSummaryReader("https://api.example", token, {
    fetcher: fetcher(async () => Response.json(body)),
  });
  await assert.rejects(read(), { message: "Snapshot unavailable" });
  body = { ...envelope(), version: 1 };
  await assert.rejects(read(), { message: "Snapshot unavailable" });
  body = { ...envelope(), asOfCheckpoint: 9007199254740992 };
  await assert.rejects(read(), { message: "Snapshot unavailable" });
  body = {
    ...envelope(),
    volumeWindows: {
      ...envelope().volumeWindows,
      "24h": { receipts: "1", priced_receipts: "1", priced_usd: 1 },
    },
  };
  await assert.rejects(read(), { message: "Snapshot unavailable" });
  body = { version: 2 };
  await assert.rejects(read(), { message: "Snapshot unavailable" });
  body = envelope();
  assert.equal((await read()).version, 2);
});
test("upstream credentials, paths, fragments, redirects and invalid tokens fail closed", async () => {
  assert.throws(() => upstreamEndpoint("http://api.example", true), {
    message: "Invalid private analytics API configuration",
  });
  assert.throws(() => upstreamEndpoint("https://secret:password@api.example"), {
    message: "Invalid private analytics API configuration",
  });
  assert.throws(() => upstreamEndpoint("https://api.example/summary"), {
    message: "Invalid private analytics API configuration",
  });
  assert.throws(() => upstreamEndpoint("https://api.example/#"), {
    message: "Invalid private analytics API configuration",
  });
  assert.throws(() => createSummaryReader("https://api.example", token + " "), {
    message: "Invalid private analytics API configuration",
  });
  assert.equal(
    upstreamEndpoint("http://127.0.0.1:8080", true).pathname,
    "/v1/summary",
  );
  const read = createSummaryReader("https://api.example", token, {
    fetcher: fetcher(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example" },
        }),
    ),
  });
  await assert.rejects(read(), { message: "Snapshot unavailable" });
});
