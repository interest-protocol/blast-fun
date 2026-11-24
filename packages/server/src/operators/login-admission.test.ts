import assert from "node:assert/strict";
import test from "node:test";
import { createAdminLoginAdmissionRoute } from "@blast/server/operators/login-admission.ts";

const SECRET = "synthetic-operator-secret-32-characters-minimum";
const URL = "https://backend.blast.test/api/admin/login-admission";
function request(body = '{"clientAddress":"192.0.2.1"}', headers: Record<string, string> = {}, method = "POST") {
  return new Request(URL, { method, headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json", ...headers }, ...(method === "POST" ? { body } : {}) });
}
function fixture() {
  const subjects: unknown[] = [];
  let allowed = true;
  let unavailable = false;
  const route = createAdminLoginAdmissionRoute({ secret: SECRET, limiter: {
    async consume() { throw new Error("Atomic admission required"); },
    async consumeAll(buckets, subject) {
      subjects.push({ buckets, subject });
      if (unavailable) throw new Error("private Redis error");
      return { allowed, bucket: "admin_login_ip", policyVersion: 1, retryAfterSeconds: allowed ? 0 : 17 };
    },
  } });
  return { route, subjects, refuse: () => { allowed = false; }, fail: () => { unavailable = true; } };
}

test("login attempt admission requires server authority and rejects browser/read/partner context before Redis", async () => {
  const { route, subjects } = fixture();
  for (const headers of [
    { authorization: "" }, { authorization: "Bearer wrong" },
    { authorization: `Bearer blast_pk_${"a".repeat(43)}` },
    { origin: "https://admin.blast.test" },
    { "x-blast-partner-key": `blast_pk_${"a".repeat(43)}` },
    { "x-blast-gateway-signature": "forged" },
  ] as Record<string, string>[]) assert.ok((await route(request(undefined, headers))).status >= 400);
  assert.equal((await route(request(undefined, {}, "GET"))).status, 405);
  assert.equal((await route(new Request(`${URL}?extra=true`, { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, body: '{"clientAddress":"192.0.2.1"}' }))).status, 403);
  assert.deepEqual(subjects, []);
});

test("login admission parses only bounded unambiguous canonical IP schema", async () => {
  const { route, subjects } = fixture();
  for (const body of [
    '{}', '{"password":"not-accepted"}', '{"clientAddress":"192.0.2.1","extra":1}',
    '{"clientAddress":"192.0.2.1","clientAddress":"192.0.2.2"}',
    '{"clientAddress":"192.0.2.1,192.0.2.2"}', '{"clientAddress":"localhost"}',
    '{"clientAddress":"::ffff:c000:201"}', '{"clientAddress":"2001:DB8::1"}',
    ' '.repeat(257),
  ]) assert.equal((await route(request(body))).status, 400, body);
  assert.equal((await route(request(undefined, { "content-type": "text/plain" }))).status, 415);
  assert.deepEqual(subjects, []);
  assert.equal((await route(request())).status, 204);
  assert.equal((await route(request('{"clientAddress":"2001:db8::1"}'))).status, 204);
  assert.deepEqual(subjects, [
    { buckets: ["admin_login_ip", "admin_login_global"], subject: { ip: "192.0.2.1" } },
    { buckets: ["admin_login_ip", "admin_login_global"], subject: { ip: "2001:db8:0:0::/64" } },
  ]);
});

// This fails if a client that stops sending mid-body holds the route open instead of being refused.
test("a body that stalls past its one-second budget is refused without spending quota", async (t) => {
  const { route, subjects } = fixture();
  const budgets: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    budgets.push(ms);
    const deadline = new AbortController();
    setTimeout(() => deadline.abort(new DOMException("The operation timed out.", "TimeoutError")), 0);
    return deadline.signal;
  });
  const stalled = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode('{"clientAddress":')) });
  const response = await route(new Request(URL, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: stalled,
    duplex: "half",
  } as RequestInit));
  assert.equal(response.status, 400);
  assert.deepEqual(budgets, [1000]);
  assert.deepEqual(subjects, []);
});

test("attempt capability has no grant payload, rejects all attempts when store unavailable, and uses atomic refusal", async () => {
  const { route, refuse, fail } = fixture();
  const allowed = await route(request());
  assert.equal(allowed.status, 204);
  assert.equal(await allowed.text(), "");
  assert.equal(allowed.headers.get("set-cookie"), null);
  refuse();
  const denied = await route(request());
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "17");
  fail();
  const unavailable = await route(request());
  assert.equal(unavailable.status, 503);
  assert.ok(!(await unavailable.text()).includes("private Redis"));
});

test("a short admission secret refuses even its exact bearer before reading the body or spending quota", async () => {
  let calls = 0;
  const route = createAdminLoginAdmissionRoute({ secret: "short", limiter: {
    async consume() { calls++; throw new Error("No store access allowed"); },
    async consumeAll() { calls++; throw new Error("No store access allowed"); },
  } });
  const input = request(undefined, { authorization: "Bearer short" });
  assert.equal((await route(input)).status, 401);
  assert.equal(input.bodyUsed, false); assert.equal(calls, 0);
});
