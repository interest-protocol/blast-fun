import assert from "node:assert/strict";
import test from "node:test";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { createBackendHttp } from "../src/app/server.ts";
import { requestWorkSignal } from "@blast/server/lib/request-work.ts";

const cases = [
  ["GET", "/api/social/me/vesting", "social.vesting.mine", 0, 60_000],
  ["GET", "/api/social/me/vesting/attempts/synthetic-id", "social.vesting.attempt.read", 0, 30_000],
  [
    "PUT",
    "/api/social/me/vesting/attempts/synthetic-id",
    "social.vesting.attempt.prepare",
    65_536,
    120_000,
  ],
  ["GET", "/api/social/me/bridge-withdrawals/quote", "social.bridge.withdraw.quote", 0, 30_000],
  ["POST", "/api/social/me/bridge-withdrawals", "social.bridge.withdraw.create", 4096, 120_000],
  [
    "POST",
    "/api/social/me/bridge-withdrawals/synthetic-id/settle",
    "social.bridge.withdraw.settle",
    0,
    30_000,
  ],
] as const;

for (const [method, path, id, bytes, budget] of cases) {
  test(`${method} ${path} retains its reviewed body and work boundary`, () => {
    const route = privateRoute(method, path, "browser");
    assert.equal(route?.id, id);
    assert.equal(route.maxBodyBytes, bytes);
    assert.equal(route.workBudgetMs ?? 30_000, budget);
    assert.equal(
      privateRoute(method, path, "ssr-read"),
      null,
      "Personal financial capabilities never authorize SSR",
    );
    assert.equal(privateRoute("DELETE", path, "browser"), null);
    if (method === "GET") {
      assert.equal(privateRoute("HEAD", path, "browser")?.id, id);
    }
  });
}

test("financial proof rejection never invokes business work and authenticated disconnect aborts the actual ALS owner", async () => {
  const origin = "https://frontend.test";
  const secret = "synthetic-financial-transport-secret-0123456789";
  const namespace = "f".repeat(64);
  const controller = new AbortController();
  let calls = 0;
  let entered!: () => void;
  let finish!: () => void;
  let signal: AbortSignal | undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runtime = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: {
      siteOrigin: origin,
      async handle() {
        calls++;
        signal = requestWorkSignal();
        entered();
        await held;
        return new Response("ok");
      },
    },
  });

  function request(valid: boolean) {
    const source = new Request(origin + "/api/social/me/bridge-withdrawals", {
      method: "POST",
      body: "{}",
    });
    const headers = signPrivateRequest(source, new TextEncoder().encode("{}"), secret, {
      namespace,
      purpose: "browser",
      siteOrigin: origin,
      ip: "192.0.2.1",
    });
    if (!valid) {
      headers.set("x-blast-private-signature", "invalid");
    }
    return new Request(source.url, {
      method: "POST",
      body: "{}",
      headers,
      signal: controller.signal,
    });
  }

  try {
    const rejected = await runtime.fetch(request(false), "127.0.0.1");
    assert.equal(rejected.status, 403);
    await rejected.arrayBuffer();
    assert.equal(calls, 0);
    const pending = runtime.fetch(request(true), "127.0.0.1");
    await started;
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    controller.abort(new Error("synthetic disconnect"));
    const response = await pending;
    assert.equal(response.status, 503);
    await response.arrayBuffer();
    assert.equal(signal.aborted, true, "Paginated SDK calls see the whole-request abort");
  } finally {
    finish();
    await runtime.drain();
  }
});
