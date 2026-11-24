import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import {
  PARTNER_ADMIN_HTTP_MS,
  PARTNER_ADMIN_OPERATION_MS,
  PARTNER_ADMIN_RELAY_MS,
} from "@blast/core/modules/backend-api/admin-budget.ts";
import { createBackendServer } from "../src/app/server.ts";

test(
  "authenticated partner admin work beyond four seconds returns its actual result",
  { timeout: 15_000 },
  async () => {
    const secret = "synthetic-admin-secret-01234567890123456789";
    const runtime = createBackendServer({
      gatewaySecret: secret,
      adminToken: secret,
      namespace: "admin-budget-fixture",
      redis: { execute: async () => "OK" },
      ready: async () => true,
      async handle(request) {
        assert.equal(request.headers.get("authorization"), `Bearer ${secret}`);
        await pause(5_200);
        return Response.json({ completed: true }, { headers: { "X-Request-ID": "admin-owner" } });
      },
    });
    try {
      assert.equal(PARTNER_ADMIN_OPERATION_MS, 8_000);
      assert.equal(PARTNER_ADMIN_HTTP_MS, 9_000);
      assert.equal(PARTNER_ADMIN_RELAY_MS, 10_000);
      const answer = await fetch(`http://127.0.0.1:${runtime.server.port}/api/admin/partner-keys`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get("x-request-id"), "admin-owner");
      assert.deepEqual(await answer.json(), { completed: true });
    } finally {
      await runtime.drain();
    }
  },
);
