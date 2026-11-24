import assert from "node:assert/strict";
import test from "node:test";
import { createAdminGasPoolHealthRoute } from "@blast/server/operators/gas-pool-health.ts";

const SECRET = "synthetic-private-operator-bearer-at-least-32-characters";
const ORIGIN = "https://pool.blast.test";
function request(token = SECRET, method = "GET", query = "") {
  return new Request(
    `https://backend.blast.test/api/admin/gas-pool/health${query}`,
    {
      method,
      headers: { authorization: `Bearer ${token}` },
    },
  );
}
function fixture(answer: (url: string) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const route = createAdminGasPoolHealthRoute({
    origin: () => ORIGIN,
    now: () => Date.parse("2026-10-24T00:00:00.000Z"),
    fetcher: (async (url, init) => {
      calls.push({ url: String(url), init });
      return answer(String(url));
    }) as typeof fetch,
  });
  return { route, calls };
}
test("gas-pool health uses bounded fixed public paths and never forwards operator credentials", async (t) => {
  const timeout = AbortSignal.timeout;
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    deadlines.push(duration);
    return timeout(duration);
  });
  const { route, calls } = fixture(
    async (url) =>
      new Response(url.endsWith("/version") ? "sponsor/1\n" : "OK"),
  );
  const response = await route(request());
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    up: true,
    version: "sponsor/1",
    latencyMs: 0,
    checkedAt: "2026-10-24T00:00:00.000Z",
  });
  assert.deepEqual(
    calls.map((call) => call.url),
    [`${ORIGIN}/`, `${ORIGIN}/version`],
  );
  for (const { init } of calls) {
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    assert.equal(init?.headers, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
  }
  assert.deepEqual(
    deadlines,
    [3000],
    "One total 3s deadline fits within the 4s transport deadline",
  );
  assert.equal(
    calls[0]?.init?.signal,
    calls[1]?.init?.signal,
    "One deadline bounds both requests",
  );
});
test("failed health is down; version failure alone preserves up", async () => {
  for (const answer of [
    () => new Response("wrong"),
    () => new Response("OK", { status: 503 }),
    () => {
      throw new Error("private failure");
    },
    () => new Response("x".repeat(257)),
  ]) {
    const { route, calls } = fixture(async () => answer());
    const response = await route(request());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.up, false);
    assert.equal(body.version, null);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(JSON.stringify(body), /private failure/);
  }
  for (const version of [
    () => {
      throw new Error("version failed");
    },
    () => new Response("x".repeat(1025)),
  ]) {
    const { route } = fixture(async (url) =>
      url.endsWith("/version") ? version() : new Response("OK"),
    );
    assert.equal((await (await route(request())).json()).up, true);
  }
});
test("configuration, methods and query fail closed without a default host", async () => {
  const { route, calls } = fixture(async () => {
    throw new Error("Must not fetch");
  });
  assert.equal((await route(request(SECRET, "POST"))).status, 405);
  assert.equal(
    (await route(request(SECRET, "GET", "?url=https://other.test"))).status,
    400,
  );
  for (const origin of [
    undefined,
    "http://pool.blast.test",
    "https://user:password@pool.blast.test",
    "https://pool.blast.test/path",
    "https://pool.blast.test/?q=x",
    "https://pool.blast.test/#x",
  ]) {
    const invalid = createAdminGasPoolHealthRoute({
      origin: () => origin,
      fetcher: async () => {
        throw new Error("Must not fetch");
      },
    });
    assert.equal((await invalid(request())).status, 503);
  }
  assert.deepEqual(calls, []);
});
test("loopback HTTP is available only through an explicit local fixture option", async () => {
  const calls: string[] = [];
  const route = createAdminGasPoolHealthRoute({
    origin: () => "http://127.0.0.1:12345",
    allowLocalHttp: true,
    fetcher: (async (url) => {
      calls.push(String(url));
      return new Response("not ready");
    }) as typeof fetch,
  });
  assert.equal((await route(request())).status, 200);
  assert.deepEqual(calls, ["http://127.0.0.1:12345/"]);
  const external = createAdminGasPoolHealthRoute({
    origin: () => "http://external.test",
    allowLocalHttp: true,
  });
  assert.equal((await external(request())).status, 503);
  const anyLoopback = createAdminGasPoolHealthRoute({
    origin: () => "http://127.5.6.7:12345",
    allowLocalHttp: true,
    fetcher: (async () => new Response("not ready")) as typeof fetch,
  });
  assert.equal((await anyLoopback(request())).status, 200);
  const refusedLoopback = createAdminGasPoolHealthRoute({
    origin: () => "http://127.5.6.7:12345",
  });
  assert.equal((await refusedLoopback(request())).status, 503);
});
