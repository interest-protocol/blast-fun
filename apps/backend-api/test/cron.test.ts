import { cronRoute, CRON_ROUTES } from "@blast/core/modules/backend-api/cron-routes.ts";
import {
  CLEANUP_TABLES,
  type CleanupReport,
} from "@blast/core/modules/mission-control/maintenance/contracts.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { requestWorkSignal, trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createCronHttp } from "../src/app/api/cron-http.ts";
import { createBackendHttp } from "../src/app/server.ts";
import { deferred } from "../../../packages/core/test/kit.ts";

const secret = "synthetic-cron-secret-0123456789";
const cleanup = "/api/mission-control/maintenance/cleanup";
const retiredPaths = ["projection", "x-verifications"].map(
  (action) => `/api/mission-control/maintenance/${action}`,
);
const cleanupReport: CleanupReport = {
  ok: true,
  complete: true,
  durationMs: 5,
  tables: Object.fromEntries(
    CLEANUP_TABLES.map((table) => [
      table,
      { batches: 1, complete: true, deleted: 0, durationMs: 1 },
    ]),
  ) as CleanupReport["tables"],
};

function fixture(handle: (request: Request) => Promise<Response>, maxInflight = 4) {
  return createBackendHttp({
    gatewaySecret: "synthetic-gateway-secret-0123456789",
    namespace: "cron-fixture",
    maxInflight,
    maxAdminInflight: 1,
    redis: {
      execute: async () => {
        throw new Error("Cron must not use partner/private authority");
      },
    },
    ready: async () => true,
    handle: async () => new Response(null, { status: 404 }),
    cronSecret: secret,
    cronApi: { handle },
  });
}

function request(
  path = cleanup,
  method = "GET",
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) {
  return new Request(`http://backend.test${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...headers },
    signal,
  });
}

async function status(response: Response) {
  await response.text();
  return response.status;
}

async function tick() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

test("only cleanup GET/HEAD dispatch once and strip caller privilege headers", async () => {
  const seen: string[] = [];
  const http = fixture(async (incoming) => {
    seen.push(`${incoming.method} ${new URL(incoming.url).pathname}`);
    assert.deepEqual([...incoming.headers.keys()], []);
    assert.equal(requestWorkSignal()?.aborted, false);
    assert.equal(incoming.signal.aborted, false);
    return Response.json({ done: true }, { headers: { "Cache-Control": "no-store" } });
  });
  try {
    for (const method of ["GET", "HEAD"]) {
      const answer = await http.fetch(
        request(cleanup, method, {
          cookie: "retained",
          "x-blast-partner-key": "partner",
          "x-forwarded-for": "203.0.113.1",
        }),
        "127.0.0.1",
      );
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get("cache-control"), "no-store");
      assert.equal(await answer.text(), method === "HEAD" ? "" : '{"done":true}');
    }
    for (const path of [cleanup + "/", ...retiredPaths]) {
      assert.equal(await status(await http.fetch(request(path), "127.0.0.1")), 404);
    }
    assert.equal(await status(await http.fetch(request(cleanup, "POST"), "127.0.0.1")), 405);
    assert.deepEqual(seen, ["GET " + cleanup, "HEAD " + cleanup]);
  } finally {
    await http.drain();
  }
});

test("authenticated cron rejects nonzero request bytes before owner work", async () => {
  let calls = 0;
  const http = fixture(async () => {
    calls++;
    return Response.json({ ok: true });
  });
  try {
    assert.equal(
      await status(
        await http.fetch(request(cleanup, "GET", { "content-length": "1" }), "127.0.0.1"),
      ),
      413,
    );
    assert.equal(calls, 0);
  } finally {
    await http.drain();
  }
});

test("Effect cleanup preserves the cron report, HEAD execution, and safe error envelopes", async () => {
  let outcome: CleanupReport | Error = cleanupReport;
  const signals: (boolean | undefined)[] = [];
  const cron = createCronHttp(async () => {
    signals.push(requestWorkSignal()?.aborted);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome;
  });
  const http = fixture(cron.handler);
  try {
    const success = await http.fetch(request(cleanup + "?ignored=1"), "127.0.0.1");
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("cache-control"), "no-store");
    assert.equal(success.headers.get("content-type"), "application/json;charset=utf-8");
    assert.deepEqual(await success.json(), cleanupReport);

    const head = await http.fetch(request(cleanup, "HEAD"), "127.0.0.1");
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "application/json;charset=utf-8");
    assert.equal(await head.text(), "");

    const partial = { ...cleanupReport, complete: false, ok: false };
    outcome = partial;
    const failed = await http.fetch(request(), "127.0.0.1");
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get("cache-control"), "no-store");
    assert.match(failed.headers.get("x-request-id")!, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await failed.json(), {
      ...partial,
      error: {
        code: "CLEANUP_FAILED",
        message: "Some cleanup steps failed. Check the reference ID in server logs.",
      },
    });

    outcome = new Error("synthetic secret error text");
    const unavailable = await http.fetch(request(), "127.0.0.1");
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    assert.equal(unavailable.headers.get("retry-after"), "5");
    assert.deepEqual(await unavailable.json(), {
      error: {
        code: "CLEANUP_UNAVAILABLE",
        message: "Cleanup is temporarily unavailable.",
      },
    });
    assert.deepEqual(signals, [false, false, false, false]);
  } finally {
    await http.drain();
    await cron.dispose();
  }
});

test("two active cron operations occupy the existing global envelope and retain ownership after cancellation", async () => {
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const cron = createCronHttp(async () => {
    calls++;
    if (calls === 2) {
      entered.resolve();
    }
    if (calls <= 2) {
      await gate.promise;
    }
    return cleanupReport;
  });
  const http = fixture(cron.handler, 2);
  const controller = new AbortController();
  const first = http.fetch(request(cleanup, "GET", {}, controller.signal), "127.0.0.1");
  const second = http.fetch(request(cleanup), "127.0.0.1");
  try {
    await entered.promise;
    assert.equal(calls, 2);
    controller.abort();
    assert.equal(await status(await first), 503);
    assert.equal(await status(await http.fetch(request(cleanup), "127.0.0.1")), 503);
    assert.equal(
      await status(
        await http.fetch(new Request("http://backend.test/api/v1/market/status"), "127.0.0.1"),
      ),
      503,
    );
    let drained = false;
    const drain = http.drain().then(() => {
      drained = true;
    });
    await tick();
    assert.equal(drained, false);
    gate.resolve();
    assert.equal(await status(await second), 200);
    await drain;
    assert.equal(calls, 2);
  } finally {
    gate.resolve();
    await Promise.all([first, second]);
    await http.drain();
    await cron.dispose();
  }
});

test("successful cron responses keep both permits until registered children actually settle", async () => {
  const gate = deferred();
  let calls = 0;
  const http = fixture(async () => {
    calls++;
    trackRequestWork(gate.promise);
    return Response.json({ accepted: true });
  });
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(await status(await http.fetch(request(), "127.0.0.1")), 200);
    }
    assert.equal(await status(await http.fetch(request(), "127.0.0.1")), 503);
    assert.equal(calls, 2);
    let drained = false;
    const drain = http.drain().then(() => {
      drained = true;
    });
    await tick();
    assert.equal(drained, false);
    gate.resolve();
    await drain;
  } finally {
    gate.resolve();
    await http.drain();
  }
});

test("cron proof headers do not create a browser capability and native idle extension happens only after authorization", async () => {
  let calls = 0;
  const budgets: number[] = [];
  const http = fixture(async () => {
    calls++;
    return new Response(null, { status: 204 });
  });
  try {
    assert.equal(
      await status(
        await http.fetch(
          request(cleanup, "GET", {
            "x-blast-private-signature": "browser-proof",
          }),
          "127.0.0.1",
          0,
          (contract) => {
            budgets.push(contract.workBudgetMs!);
          },
        ),
      ),
      403,
    );
    assert.equal(
      await status(
        await http.fetch(
          request(cleanup, "GET", { authorization: "" }),
          "127.0.0.1",
          0,
          (contract) => {
            budgets.push(contract.workBudgetMs!);
          },
        ),
      ),
      401,
    );
    assert.equal(calls, 0);
    assert.equal(budgets.length, 0);
    assert.equal(
      await status(
        await http.fetch(request(), "127.0.0.1", 0, (contract) => {
          budgets.push(contract.workBudgetMs!);
        }),
      ),
      204,
    );
    assert.equal(calls, 1);
    assert.deepEqual(budgets, [60_000]);
  } finally {
    await http.drain();
  }
});

test("cron registry and Next adapters are a closed transport surface with explicit HEAD execution", async () => {
  assert.deepEqual(CRON_ROUTES, [cleanup]);
  for (const path of CRON_ROUTES) {
    for (const method of ["GET", "HEAD"]) {
      assert.deepEqual(cronRoute(method, path), {
        path,
        method,
        maxBodyBytes: 0,
        workBudgetMs: 60_000,
      });
    }
    assert.equal(cronRoute("POST", path), null);
    assert.equal(cronRoute("GET", path + "/"), null);
  }
});

test("cron cancellation reaches the canonical Request and request-work context", async () => {
  const entered = deferred();
  const release = deferred();
  let canonical: AbortSignal | undefined;
  let owned: AbortSignal | undefined;
  const http = fixture(async (job) => {
    canonical = job.signal;
    owned = requestWorkSignal();
    entered.resolve();
    await release.promise;
    return new Response(null, { status: 204 });
  });
  const controller = new AbortController();
  const pending = http.fetch(request(cleanup, "GET", {}, controller.signal), "127.0.0.1");
  try {
    await entered.promise;
    assert.equal(canonical?.aborted, false);
    assert.equal(owned?.aborted, false);
    controller.abort();
    assert.equal(await status(await pending), 503);
    assert.equal(canonical?.aborted, true);
    assert.equal(owned?.aborted, true);
  } finally {
    release.resolve();
    await pending;
    await http.drain();
  }
});

test("transport preserves owner request IDs and generates IDs only when absent", async () => {
  for (const ownerId of ["owner-correlation", undefined]) {
    const http = fixture(
      async () =>
        new Response(null, { status: 204, headers: ownerId ? { "X-Request-ID": ownerId } : {} }),
    );
    try {
      const response = await http.fetch(request(), "127.0.0.1");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const id = response.headers.get("x-request-id");
      if (ownerId) {
        assert.equal(id, ownerId);
      } else {
        assert.match(id!, /^[0-9a-f-]{36}$/);
      }
      await response.text();
    } finally {
      await http.drain();
    }
  }
});
