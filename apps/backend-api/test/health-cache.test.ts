import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { createBackendHttp, createBackendServer } from "../src/app/server.ts";

const redis = {
  async execute() {
    return "OK";
  },
};

const options = {
  redis,
  namespace: "a".repeat(64),
  gatewaySecret: "synthetic-gateway-secret-01234567890123456789",
  async handle() {
    throw new Error("Health probes cannot reach feature handlers.");
  },
};

test(
  "a failed readiness probe is reused for 1 s and a passing one for 5 s",
  { timeout: 20_000 },
  async (t) => {
    let readyCalls = 0;
    let passing = false;
    const runtime = createBackendServer({
      ...options,
      async ready() {
        readyCalls++;
        return passing;
      },
    });
    t.after(() => runtime.drain());
    const probe = async () => {
      const response = await fetch(`http://127.0.0.1:${runtime.server.port}/v1/health`);
      await response.body?.cancel();
      return response.status;
    };
    assert.equal(await probe(), 503);
    assert.equal(await probe(), 503);
    assert.equal(readyCalls, 1, "an immediate repeat reuses the failed result");
    passing = true;
    await pause(1_100);
    assert.equal(await probe(), 200, "a recovered replica rejoins after about 1 s, not 5 s");
    assert.equal(readyCalls, 2);
    passing = false;
    await pause(1_100);
    assert.equal(await probe(), 200, "a passing result is still reused within 5 s");
    assert.equal(readyCalls, 2);
  },
);

test("readiness preserves native status, headers and body for each admitted method", async (t) => {
  for (const [ready, status, body, length] of [
    [true, 200, "ready", "5"],
    [false, 503, "unavailable", "11"],
  ] as const) {
    const runtime = createBackendServer({ ...options, ready: async () => ready });
    t.after(() => runtime.drain());
    const url = `http://127.0.0.1:${runtime.server.port}/v1/health?probe=1`;

    for (const [method, expectedBody, expectedLength] of [
      ["GET", body, length],
      ["HEAD", "", "0"],
      ["OPTIONS", body, length],
    ] as const) {
      const response = await fetch(url, { method });
      assert.equal(response.status, status, method);
      assert.equal(response.headers.get("content-length"), expectedLength, method);
      assert.equal(response.headers.get("content-type"), null, method);
      assert.equal(response.headers.get("cache-control"), null, method);
      assert.equal(response.headers.get("retry-after"), null, method);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", method);
      assert.match(response.headers.get("x-request-id") ?? "", /^[\da-f-]{36}$/);
      assert.equal(await response.text(), expectedBody, method);
    }
  }
});

test("a disconnected readiness request holds its permit until the shared check completes", async (t) => {
  const started = Promise.withResolvers<void>();
  const checked = Promise.withResolvers<boolean>();
  const app = createBackendHttp({
    ...options,
    ready() {
      started.resolve();
      return checked.promise;
    },
  });
  t.after(() => {
    checked.resolve(false);
    return app.drain();
  });
  const controller = new AbortController();
  const url = "https://backend.test/v1/health";
  const probe = (signal?: AbortSignal) => app.fetch(new Request(url, { signal }), "127.0.0.1");
  const disconnected = probe(controller.signal);
  await started.promise;
  controller.abort();
  const unavailable = await disconnected;
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: { code: "service_unavailable" } });
  await pause(0);

  const others = Array.from({ length: 7 }, () => probe());
  const busy = await probe();
  assert.equal(busy.status, 503);
  assert.deepEqual(await busy.json(), { error: { code: "busy" } });

  checked.resolve(true);
  for (const response of await Promise.all(others)) {
    assert.equal(response.status, 200);
    await response.body?.cancel();
  }
  const recovered = await probe();
  assert.equal(recovered.status, 200);
  assert.equal(await recovered.text(), "ready");
});
