import assert from "node:assert/strict";
import { test } from "node:test";
import { envelope, now, token } from "../test/fixture.ts";
import { createAccountSummaryReader } from "./account-summary.ts";

const body = () => ({
  ...envelope(),
  version: 3 as const,
  chainPublicationTimestampMs: String(now),
  accountObservationTimestampMs: String(now),
  chainStale: false,
  accountStale: false,
});
const fetcher = (read: () => Promise<Response>) => read as typeof fetch;
async function readBody(overrides: Record<string, unknown>) {
  const read = createAccountSummaryReader("https://private.example", token, {
    enabled: true,
    now: () => now,
    fetcher: fetcher(async () => Response.json({ ...body(), ...overrides })),
  });
  assert.ok(read);
  return read();
}

// Fails if merely importing/configuring the disabled v3 choice fetches data or requires new settings.
test("v3 consumer stays dormant until explicitly enabled and sends the private bearer to its fixed path", async () => {
  assert.equal(createAccountSummaryReader("invalid", ""), null);
  assert.throws(
    () =>
      createAccountSummaryReader("https://private.example", "x".repeat(31), {
        enabled: true,
      }),
    /configuration/,
  );
  assert.throws(
    () =>
      createAccountSummaryReader("https://private.example", "x".repeat(4097), {
        enabled: true,
      }),
    /configuration/,
  );
  assert.throws(
    () =>
      createAccountSummaryReader(
        "https://private.example",
        "x".repeat(32) + " ",
        { enabled: true },
      ),
    /configuration/,
  );
  assert.ok(
    createAccountSummaryReader("https://private.example", "x".repeat(32), {
      enabled: true,
      timeoutMs: 1,
    }),
  );
  assert.ok(
    createAccountSummaryReader("https://private.example", "x".repeat(4096), {
      enabled: true,
    }),
  );
  assert.throws(
    () =>
      createAccountSummaryReader("https://private.example", token, {
        enabled: true,
        timeoutMs: 0,
      }),
    /deadline/,
  );
  assert.throws(
    () =>
      createAccountSummaryReader("https://private.example", token, {
        enabled: true,
        timeoutMs: 3001,
      }),
    /deadline/,
  );
  assert.throws(
    () =>
      createAccountSummaryReader("https://private.example", token, {
        enabled: true,
        timeoutMs: 1.5,
      }),
    /deadline/,
  );
  let calls = 0;
  const load = createAccountSummaryReader("https://private.example", token, {
    enabled: true,
    now: () => now,
    fetcher: (async (input, options) => {
      calls++;
      assert.equal(String(input), "https://private.example/v3/summary");
      assert.equal(
        new Headers(options?.headers).get("authorization"),
        `Bearer ${token}`,
      );
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal);
      return Response.json(body());
    }) as typeof fetch,
  });
  assert.ok(load);
  const [one, two] = await Promise.all([load(), load()]);
  assert.equal(calls, 1);
  assert.equal(one.version, 3);
  assert.equal(one.stale, false);
  assert.deepEqual(one, two);
  await load();
  assert.equal(calls, 1);
  assert.equal(
    one.volumeWindows["24h"].priced_usd,
    "9007199254740993.123456789012345678",
  );
});

// Fails if either source clock, future timestamp, publication clock, or upstream stale claim is hidden by cache.
test("v3 account and chain freshness age independently and cached reads remain honest", async () => {
  let clock = now;
  const load = createAccountSummaryReader("https://private.example", token, {
    enabled: true,
    now: () => clock,
    fetcher: fetcher(async () =>
      Response.json({ ...body(), asOfTimestampMs: String(now - 3590000) }),
    ),
  });
  assert.ok(load);
  assert.equal((await load()).chainStale, false);
  clock += 20000;
  assert.equal((await load()).chainStale, true);
  assert.equal((await load()).stale, true);
  assert.equal((await load()).accountStale, false);
  const future = createAccountSummaryReader("https://private.example", token, {
    enabled: true,
    now: () => now,
    fetcher: fetcher(async () =>
      Response.json({
        ...body(),
        accountObservationTimestampMs: String(now + 1),
      }),
    ),
  });
  assert.ok(future);
  assert.equal((await future()).accountStale, true);
  assert.equal((await future()).stale, true);
  assert.equal((await future()).chainStale, false);
  const publication = createAccountSummaryReader(
    "https://private.example",
    token,
    {
      enabled: true,
      now: () => now,
      fetcher: fetcher(async () =>
        Response.json({
          ...body(),
          generatedAt: new Date(now - 3600001).toISOString(),
        }),
      ),
    },
  );
  assert.ok(publication);
  assert.equal((await publication()).accountStale, true);
  assert.equal((await publication()).chainStale, true);
  const oldChain = createAccountSummaryReader(
    "https://private.example",
    token,
    {
      enabled: true,
      now: () => now,
      fetcher: fetcher(async () =>
        Response.json({
          ...body(),
          chainPublicationTimestampMs: String(now - 3600001),
        }),
      ),
    },
  );
  assert.ok(oldChain);
  assert.equal((await oldChain()).chainStale, true);
  assert.equal((await oldChain()).accountStale, false);
  const futureChain = createAccountSummaryReader(
    "https://private.example",
    token,
    {
      enabled: true,
      now: () => now,
      fetcher: fetcher(async () =>
        Response.json({
          ...body(),
          chainPublicationTimestampMs: String(now + 1),
        }),
      ),
    },
  );
  assert.ok(futureChain);
  assert.equal((await futureChain()).chainStale, true);
  assert.equal((await readBody({ stale: true })).stale, true);
  assert.equal(
    (
      await readBody({
        asOfTimestampMs: String(now - 3600000),
        chainPublicationTimestampMs: String(now - 3600000),
        accountObservationTimestampMs: String(now - 3600000),
        generatedAt: new Date(now - 3600000).toISOString(),
      })
    ).stale,
    false,
  );
});

// Fails if a numeric count, unknown hash field, or old contract can enter the strict v3 cache.
test("v3 rejects contract drift and serves a bounded explicitly degraded last good report", async () => {
  let clock = now;
  let response: unknown = { ...body(), version: 2 };
  const load = createAccountSummaryReader("https://private.example", token, {
    enabled: true,
    now: () => clock,
    fetcher: fetcher(async () => Response.json(response)),
  });
  assert.ok(load);
  await assert.rejects(load(), { message: "Snapshot unavailable" });
  response = { ...body(), account_hash: "secret" };
  await assert.rejects(load(), { message: "Snapshot unavailable" });
  response = { ...body(), accountObservationTimestampMs: 9007199254740992 };
  await assert.rejects(load(), { message: "Snapshot unavailable" });
  response = {
    ...body(),
    accountActivity: {
      unit: "authenticated-existing-accounts",
      collectionStartedAt: new Date(now).toISOString(),
      dau24h: 9007199254740992,
      mau30d: "0",
      uniqueSinceCollection: "0",
      partial30d: true,
      samplingIntervalMs: 900000,
      daily: [],
    },
  };
  await assert.rejects(load(), { message: "Snapshot unavailable" });
  response = body();
  assert.equal((await load()).version, 3);
  clock += 60000;
  response = {};
  assert.equal((await load()).deliveryDegraded, true);
  assert.equal((await load()).stale, true);
  clock = now + 86400000;
  await assert.rejects(load(), { message: "Snapshot unavailable" });
});

// Fails if chunked JSON can exceed the byte cap or a stalled stream can outlive the whole request deadline.
test(
  "v3 bounds complete streamed responses and cancels stalled delivery without leaking secrets",
  { timeout: 1000 },
  async () => {
    let size = 1000000;
    const load = createAccountSummaryReader("https://private.example", token, {
      enabled: true,
      now: () => now,
      fetcher: fetcher(
        async () =>
          new Response(JSON.stringify(body()).padEnd(size, " "), {
            headers: { "content-length": "1000000" },
          }),
      ),
    });
    assert.ok(load);
    assert.equal((await load()).version, 3);
    size = 1000001;
    const overflow = createAccountSummaryReader(
      "https://private.example",
      token,
      {
        enabled: true,
        fetcher: fetcher(
          async () => new Response(JSON.stringify(body()).padEnd(size, " ")),
        ),
      },
    );
    assert.ok(overflow);
    await assert.rejects(overflow(), { message: "Snapshot unavailable" });
    let refusedSignal: AbortSignal | null | undefined;
    const refused = createAccountSummaryReader(
      "https://private.example",
      token,
      {
        enabled: true,
        fetcher: (async (_input, options) => {
          refusedSignal = options?.signal;
          return new Response(JSON.stringify(body()), { status: 401 });
        }) as typeof fetch,
      },
    );
    assert.ok(refused);
    await assert.rejects(refused(), { message: "Snapshot unavailable" });
    assert.equal(refusedSignal?.aborted, true);
    const headerOverflow = createAccountSummaryReader(
      "https://private.example",
      token,
      {
        enabled: true,
        fetcher: fetcher(
          async () =>
            new Response(JSON.stringify(body()), {
              headers: { "content-length": "1000001" },
            }),
        ),
      },
    );
    assert.ok(headerOverflow);
    await assert.rejects(headerOverflow(), { message: "Snapshot unavailable" });
    const redirected = Response.json(body());
    Object.defineProperty(redirected, "redirected", { value: true });
    const redirect = createAccountSummaryReader(
      "https://private.example",
      token,
      { enabled: true, fetcher: fetcher(async () => redirected) },
    );
    assert.ok(redirect);
    await assert.rejects(redirect(), { message: "Snapshot unavailable" });
    let canceled = false;
    let signal: AbortSignal | null | undefined;
    const stalled = createAccountSummaryReader(
      "https://private.example",
      token,
      {
        enabled: true,
        timeoutMs: 20,
        fetcher: (async (_input, options) => {
          signal = options?.signal;
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode('{"secret":"'));
              },
              cancel() {
                canceled = true;
              },
            }),
          );
        }) as typeof fetch,
      },
    );
    assert.ok(stalled);
    await assert.rejects(stalled(), { message: "Snapshot unavailable" });
    assert.equal(canceled, true);
    assert.equal(signal?.aborted, true);
  },
);
