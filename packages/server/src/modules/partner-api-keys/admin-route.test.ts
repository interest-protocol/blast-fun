import assert from "node:assert/strict";
import test from "node:test";
import { createAdminPartnerKeyRoute } from "@blast/server/modules/partner-api-keys/admin-route.ts";
import type { PartnerKeyPorts } from "@blast/server/modules/partner-api-keys/command.ts";

const ID = "12345678-1234-1234-1234-123456789012";
const key = { id: ID, partner_id: "acme", label: "Backend", issued_by: "operator:admin-console", created_at: new Date(), revoked_at: null, revoked_by: null, tier: "standard" as const, requests_per_minute: 300, requests_per_day: 50_000, policy_updated_at: new Date(), policy_updated_by: "operator:test-ops" };
function fixture() {
  const calls: unknown[][] = [];
  const ports: PartnerKeyPorts = {
    deleteKey: async (...args) => { calls.push(["delete-key", ...args]); return true; },
    deletePartner: async (...args) => { calls.push(["delete-partner", ...args]); return true; },
    setPolicy: async (...args) => { calls.push(["policy", ...args]); return key; },
    list: async () => { calls.push(["list"]); return { partners: [], keys: [key] }; },
    createPartner: async (partner, by) => { calls.push(["partner", partner, by]); return { ...partner, created_at: new Date(), updated_at: new Date(), created_by: by, updated_by: by }; },
    setOrigins: async () => null,
    issue: async (...args) => { calls.push(["issue", ...args]); return { ...key, key: `blast_pk_${"a".repeat(43)}` }; },
    revoke: async (id, by) => { calls.push(["revoke", id, by]); return id === ID ? { ...key, revoked_at: new Date(), revoked_by: by } : null; },
  };
  return { calls, ports, route: createAdminPartnerKeyRoute(ports) };
}
function request(body?: unknown) {
  return new Request("https://blast.fun/api/admin/partner-keys", { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
test("management uses a fixed audit actor, only issuance returns the raw key, and all responses forbid caching", async () => {
  const { route, calls } = fixture();
  const listed = await route(request());
  assert.equal(listed.headers.get("cache-control"), "no-store");
  assert.ok(!(await listed.text()).includes("blast_pk_"));
  assert.equal((await route(request({ action: "create-partner", id: "acme", origins: [] }))).status, 200);
  const issued = await route(request({ action: "issue", partnerId: "acme", label: "Backend" }));
  assert.equal((await issued.json()).apiKey.key, `blast_pk_${"a".repeat(43)}`);
  const revoked = await route(request({ action: "revoke", id: ID }));
  assert.equal((await revoked.json()).apiKey.revoked_by, "operator:admin-console");
  assert.ok(calls.some((call) => call[0] === "issue" && call[3] === "operator:admin-console"));
});
test("invalid and oversized commands never reach storage; unknown targets are distinct from outages", async () => {
  const { route, calls, ports } = fixture();
  for (const body of [
    { action: "issue", partnerId: "acme", label: "Backend", by: "forged" },
    { action: "set-policy", id: ID, policy: { tier: "internal" }, by: "forged" },
    { action: "set-policy", id: ID, policy: { tier: "internal", requestsPerMinute: 10 } },
    { action: "set-policy", id: ID, policy: { tier: "unknown" } },
    { action: "set-policy", id: ID, policy: { tier: "custom", requestsPerMinute: 20, requestsPerDay: 10 } },
    { action: "set-policy", id: ID, policy: { tier: "custom", requestsPerMinute: 0, requestsPerDay: 20 } },
    { action: "set-policy", id: ID, policy: { tier: "custom", requestsPerMinute: 2.5, requestsPerDay: 20 } },
    { action: "revoke", id: "not-a-uuid" },
    { action: "create-partner", id: "acme", origins: ["https://*.example.com"] },
    { action: "create-partner", id: "acme", origins: ["https://partner.test", "https://partner.test"] },
    { action: "issue", partnerId: "acme", label: "x".repeat(9000) },
  ]) assert.equal((await route(request(body))).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await route(request({ action: "revoke", id: "00000000-0000-0000-0000-000000000000" }))).status, 404);
  ports.issue = async () => { throw new Error("secret database credentials must not escape"); };
  const failure = await route(request({ action: "issue", partnerId: "acme", label: "Backend" }));
  assert.equal(failure.status, 503);
  assert.ok(!(await failure.text()).includes("credentials"));
});
test("a key tier change records the server-owned audit actor", async () => {
  const { route, calls } = fixture();
  const policy = { tier: "custom", requestsPerMinute: 50, requestsPerDay: 5000 };
  assert.equal((await route(request({ action: "set-policy", id: ID, policy }))).status, 200);
  assert.deepEqual(calls, [["policy", ID, policy, "operator:admin-console"]]);
});
test("deletion validates identifiers and confirms exact targets with the server audit actor", async () => {
  const { route, calls, ports } = fixture();
  for (const [action, id, field] of [["delete-key", ID, "deletedKeyId"], ["delete-partner", "acme", "deletedPartnerId"]]) {
    const body = { action, id };
    assert.equal((await route(request({ ...body, by: "forged" }))).status, 400);
    const response = await route(request(body));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { [field]: id });
    assert.deepEqual(calls.at(-1), [action, id, "operator:admin-console"]);
  }
  for (const body of [{ action: "delete-key", id: "acme" }, { action: "delete-partner", id: "../acme" }])
    assert.equal((await route(request(body))).status, 400);
  ports.deleteKey = async () => false;
  assert.equal((await route(request({ action: "delete-key", id: ID }))).status, 404);
  ports.deletePartner = async () => { throw { code: "23514", constraint: "partner_deletion_requires_revocation" }; };
  const conflict = await route(request({ action: "delete-partner", id: "acme" }));
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /Revoke all active keys/);
});
