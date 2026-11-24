import assert from "node:assert/strict";
import test from "node:test";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { createBackendHttp } from "../src/app/server.ts";

const secret = "synthetic-card-gateway-secret-0123456789";
const namespace = "c".repeat(64);
const siteOrigin = "https://frontend.test";

function signed(path: string, signal?: AbortSignal) {
  const body = new Uint8Array([137, 80, 78, 71]);
  const request = new Request(siteOrigin + path, {
    method: path.endsWith("/picture") ? "PUT" : "POST",
    headers: { origin: siteOrigin, "content-type": "image/png" },
    body,
  });
  return new Request(request, {
    headers: signPrivateRequest(request, body, secret, {
      namespace,
      purpose: "browser",
      siteOrigin,
      ip: "192.0.2.1",
    }),
    signal,
  });
}

test(
  "PnL publishing shares the existing two-image subcap and retains permits until canceled owners settle",
  { timeout: 5000 },
  async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    const http = createBackendHttp({
      gatewaySecret: secret,
      namespace,
      maxInflight: 4,
      maxAdminInflight: 1,
      redis: { execute: async () => "OK" },
      ready: async () => true,
      handle: async () => new Response("public"),
      privateApi: {
        siteOrigin,
        async handle() {
          calls++;
          if (calls === 2) {
            entered();
          }
          await gate;
          return Response.json({ saved: true });
        },
      },
    });
    const canceled = new AbortController();
    const first = http.fetch(signed("/api/social/me/pnl/card", canceled.signal), "127.0.0.1");
    const second = http.fetch(signed("/api/social/me/profile/picture"), "127.0.0.1");
    try {
      await bothEntered;
      canceled.abort();
      const answer = await first;
      assert.equal(answer.status, 503);
      await answer.text();
      for (const path of ["/api/social/me/pnl/card", "/api/social/me/profile/picture"]) {
        const busy = await http.fetch(signed(path), "127.0.0.1");
        assert.equal(busy.status, 503);
        await busy.text();
      }
      assert.equal(calls, 2);
      const publicResponse = await http.fetch(
        new Request(siteOrigin + "/api/v1/market/status"),
        "127.0.0.1",
      );
      assert.equal(publicResponse.status, 200);
      await publicResponse.text();
      let drained = false;
      const draining = http.drain().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(drained, false);
      release();
      const saved = await second;
      assert.equal(saved.status, 200);
      await saved.text();
      await draining;
    } finally {
      release();
      await Promise.allSettled([first, second]);
      await http.drain();
    }
  },
);
