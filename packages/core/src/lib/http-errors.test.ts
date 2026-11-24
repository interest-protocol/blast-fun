import assert from "node:assert/strict";
import test from "node:test";

import { publicErrorResponse } from "./http-errors.ts";

test("public errors correlate a safe response and log without exposing the exception", async (t) => {
  const lines: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>));
  const response = publicErrorResponse("EXAMPLE_UNAVAILABLE", "Try again shortly.", 503, {
    route: "example",
    cause: new Error("Authorization: Bearer private-credential; SELECT private_data"),
  });
  assert.deepEqual(await response.json(), { error: { code: "EXAMPLE_UNAVAILABLE", message: "Try again shortly." } });
  assert.match(response.headers.get("x-request-id") ?? "", /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(lines[0]?.requestId, response.headers.get("x-request-id"));
  assert.equal(lines[0]?.cause, "Error");
  assert.doesNotMatch(JSON.stringify(lines), /private-credential|private_data|Bearer/);
});

test("domain bodies, private caching and retry delays retain their existing contract", async () => {
  const body = { requestId: "req-1", error: { code: "LIMITED", message: "Wait.", retryAfterSeconds: 7 } };
  const response = publicErrorResponse("LIMITED", "Wait.", 429, {
    requestId: "req-1", body, headers: { "Cache-Control": "private, no-store", "Retry-After": "7" },
  });
  assert.deepEqual(await response.json(), body);
  assert.equal(response.headers.get("x-request-id"), "req-1");
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("legacy JSON failures preserve domain fields and identify partial failures", async () => {
  const { publicJson } = await import("./http-errors.ts");
  const response = publicJson({ projections: [{ outcome: "failed" }] }, { status: 500, headers: { "X-Request-ID": "projection-ref-1" } });
  assert.deepEqual(await response.json(), {
    projections: [{ outcome: "failed" }],
    error: { code: "SERVICE_UNAVAILABLE", message: "This service is temporarily unavailable. Please retry." },
  });
  assert.equal(response.headers.get("x-request-id"), "projection-ref-1");
  const success = publicJson({ ok: true });
  assert.deepEqual(await success.json(), { ok: true });
});

test("unexpected outer handler failures have a safe code and a matching diagnostic reference", async (t) => {
  const { safeRouteHandler } = await import("./http-errors.ts");
  const lines: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>));
  const handler = safeRouteHandler(async () => { throw new Error("private provider credential"); });
  const response = await handler();
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "INTERNAL_ERROR");
  assert.equal(lines[0]?.requestId, response.headers.get("x-request-id"));
  assert.doesNotMatch(JSON.stringify(lines), /private provider credential/);
});
