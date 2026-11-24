import assert from "node:assert/strict";
import { test } from "bun:test";
import { createBackendServer } from "../src/app/server.ts";

/** Real native idle/deadline proof: no shortened production budgets or fake clock. */
test(
  "native cron idle lifetime exceeds five seconds and its sixty-second visible deadline retains both permits through drain",
  async () => {
    const secret = "synthetic-native-cron-secret-0123456789";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runtime = createBackendServer({
      gatewaySecret: "synthetic-native-gateway-0123456789",
      namespace: "cron-native",
      maxInflight: 2,
      maxAdminInflight: 1,
      redis: {
        execute: async () => {
          throw new Error("No Redis authority for cron");
        },
      },
      ready: async () => true,
      handle: async () => new Response("public"),
      cronSecret: secret,
      cronApi: {
        async handle() {
          calls++;
          await gate;
          return Response.json({ settled: true });
        },
      },
    });
    const origin = `http://127.0.0.1:${runtime.server.port}`;
    const send = () =>
      fetch(origin + "/api/mission-control/maintenance/cleanup", {
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(68_000),
      });
    const started = Date.now();
    const answers = Promise.all([send(), send()]);
    try {
      const responses = await answers;
      assert.ok(
        Date.now() - started >= 59_000,
        "Real sixty-second owner deadline, not native five-second idleness",
      );
      assert.ok(Date.now() - started < 68_000);
      for (const response of responses) {
        assert.equal(response.status, 503);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          "service_unavailable",
        );
      }
      assert.equal(calls, 2);
      const third = await send();
      assert.equal(third.status, 503);
      await third.text();
      const publicResponse = await fetch(origin + "/api/v1/market/status");
      assert.equal(publicResponse.status, 503);
      await publicResponse.text();
      let drained = false;
      const drain = runtime.drain().then(() => {
        drained = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(drained, false);
      release();
      await drain;
      assert.equal(calls, 2);
    } finally {
      release();
      await answers.catch(() => {});
      await runtime.drain();
    }
  },
  { timeout: 75_000 },
);
