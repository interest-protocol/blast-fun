import assert from "node:assert/strict";
import test from "node:test";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { createBackendHttp } from "../src/app/server.ts";
import { requestWorkSignal } from "@blast/server/lib/request-work.ts";

const path = "/api/social/me/commits";
const origin = "https://frontend.test";
const secret = "synthetic-commit-transport-secret-0123456789";
const namespace = "c".repeat(64);

test("commit build is one browser POST with the existing body and finite work budget", () => {
  const route = privateRoute("POST", path, "browser");
  assert.equal(route?.id, "social.commit.build");
  assert.equal(route.maxBodyBytes, 4096);
  assert.equal(route.workBudgetMs, 120_000);
  assert.equal(privateRoute("POST", path, "ssr-read"), null);
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    assert.equal(privateRoute(method, path, "browser"), null);
  }
});

test("signed commit transport enforces 4096 bytes and rejects unproved work before dispatch", async () => {
  let calls = 0;
  let bytes = 0;
  const runtime = createBackendHttp({
    namespace,
    gatewaySecret: secret,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => new Response(),
    privateApi: {
      siteOrigin: origin,
      async handle(request) {
        calls++;
        assert.ok(requestWorkSignal());
        bytes = (await request.arrayBuffer()).byteLength;
        return new Response("ok");
      },
    },
  });
  const unsigned = await runtime.fetch(
    new Request(origin + path, { method: "POST", body: "{}" }),
    "127.0.0.1",
  );
  assert.equal(unsigned.status, 403);
  await unsigned.arrayBuffer();
  assert.equal(calls, 0);

  function signed(size: number) {
    const body = new Uint8Array(size);
    const source = new Request(origin + path, {
      method: "POST",
      body: body.slice().buffer,
    });
    // A valid envelope over allowed bytes lets the receiver enforce its own stream limit.
    const headers = signPrivateRequest(source, body.subarray(0, 4096), secret, {
      namespace,
      purpose: "browser",
      siteOrigin: origin,
      ip: "192.0.2.1",
    });
    return new Request(source.url, {
      method: "POST",
      body: body.slice().buffer,
      headers,
    });
  }

  const exact = await runtime.fetch(signed(4096), "127.0.0.1");
  assert.equal(exact.status, 200);
  await exact.arrayBuffer();
  assert.equal(bytes, 4096);
  const oversized = await runtime.fetch(signed(4097), "127.0.0.1");
  assert.equal(oversized.status, 413);
  await oversized.arrayBuffer();
  assert.equal(calls, 1);
});
