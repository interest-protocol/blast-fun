import assert from "node:assert/strict";
import test from "node:test";
import { parseRelayConfig } from "../private/relay-config.ts";
import { cronBackendRelay } from "./relay.ts";

test("cron relay forwards only Authorization and its exact GET/HEAD target with no redirect or credential inheritance", async () => {
  const observed: { url: string; init?: RequestInit }[] = [];
  const relay = cronBackendRelay(
    parseRelayConfig({ BLAST_BACKEND_API_ORIGIN: "https://backend.test" }),
    {
      fetch: async (url, init) => {
        observed.push({ url: String(url), init });
        return Response.json(
          { ok: true },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
  );
  for (const method of ["GET", "HEAD"]) {
    const response = await relay(
      new Request(
        "https://frontend.test/api/mission-control/maintenance/cleanup?ignored=1",
        {
          method,
          headers: {
            authorization: "Bearer synthetic-cron",
            cookie: "retained",
            "x-blast-partner-key": "partner",
            "x-blast-private-signature": "proof",
            host: "untrusted.test",
          },
        },
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(await response.text(), method === "HEAD" ? "" : '{"ok":true}');
  }
  assert.equal(observed.length, 2);
  for (const [index, value] of observed.entries()) {
    assert.equal(
      value.url,
      "https://backend.test/api/mission-control/maintenance/cleanup",
    );
    assert.equal(value.init?.method, ["GET", "HEAD"][index]);
    assert.deepEqual(
      [...new Headers(value.init?.headers)],
      [["authorization", "Bearer synthetic-cron"]],
    );
    assert.equal(value.init?.redirect, "error");
    assert.equal(value.init?.cache, "no-store");
    assert.ok(value.init?.signal instanceof AbortSignal);
    assert.equal(value.init?.body, undefined);
  }
});

test("cron relay refuses a missing backend origin and all unregistered targets without fetch", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return new Response();
  };
  const missing = cronBackendRelay(parseRelayConfig({}), { fetch });
  assert.equal(
    (await missing(new Request("https://frontend.test/api/mission-control/maintenance/cleanup"))).status,
    503,
  );
  const relay = cronBackendRelay(parseRelayConfig({ BLAST_BACKEND_API_ORIGIN: "https://backend.test" }), { fetch });
  for (const [path, method] of [
    ["cleanup/", "GET"],
    ["projection", "GET"],
    ["x-verifications", "GET"],
    ["other", "GET"],
    ["cleanup", "POST"],
  ]) {
    assert.equal(
      (
        await relay(
          new Request(
            `https://frontend.test/api/mission-control/maintenance/${path}`,
            { method },
          ),
        )
      ).status,
      404,
    );
  }
  assert.equal(calls, 0);
});

test("cron relay propagates disconnect and refuses a declared body before dispatch", async () => {
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  const relay = cronBackendRelay(
    parseRelayConfig({ BLAST_BACKEND_API_ORIGIN: "http://127.0.0.1:9999" }),
    {
      fetch: async (_url, init) => {
        signal = init?.signal;
        return new Response(null);
      },
    },
  );
  assert.equal(
    (
      await relay(
        new Request(
          "https://frontend.test/api/mission-control/maintenance/cleanup",
          { signal: controller.signal },
        ),
      )
    ).status,
    200,
  );
  controller.abort();
  assert.equal(signal?.aborted, true);
  assert.equal(
    (
      await relay(
        new Request(
          "https://frontend.test/api/mission-control/maintenance/cleanup",
          { headers: { "content-length": "1" } },
        ),
      )
    ).status,
    413,
  );
});
