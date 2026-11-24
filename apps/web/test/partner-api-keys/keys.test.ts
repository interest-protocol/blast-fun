import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import type { Pool } from "pg";
import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { generatePartnerApiKey, hashPartnerApiKey, isPartnerApiKey, partnerOriginsSchema } from "@blast/server/modules/partner-api-keys/contracts.ts";
import { parsePartnerKeyCommand, runPartnerKeyCommand, type PartnerKeyPorts } from "@blast/server/modules/partner-api-keys/command.ts";
import { createPartnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";

test("keys carry 256 random bits and only their full SHA-256 is stored", () => {
  const values = new Set(Array.from({ length: 20 }, generatePartnerApiKey));
  assert.equal(values.size, 20);
  for (const key of values) {
    assert.ok(isPartnerApiKey(key));
    assert.equal(Buffer.from(key.slice(9), "base64url").byteLength, 32);
    assert.deepEqual(hashPartnerApiKey(key), createHash("sha256").update(key).digest());
  }
});

test("commands validate stable IDs, labels, key IDs and exact HTTPS browser origins", () => {
  assert.deepEqual(parsePartnerKeyCommand(["create-partner", "acme"]), { mode: "create-partner", partner: { id: "acme", origins: [] } });
  assert.deepEqual(parsePartnerKeyCommand(["set-origins", "acme", "https://example.com"]), { mode: "set-origins", partner: { id: "acme", origins: ["https://example.com"] } });
  assert.deepEqual(parsePartnerKeyCommand(["create", "acme", "frontend"]), { mode: "create", partnerId: "acme", label: "frontend" });
  assert.deepEqual(parsePartnerKeyCommand(["delete-partner", "acme"]), { mode: "delete-partner", id: "acme" });
  assert.deepEqual(parsePartnerKeyCommand(["delete-key", "00000000-0000-4000-8000-000000000001"]), { mode: "delete-key", id: "00000000-0000-4000-8000-000000000001" });
  assert.deepEqual(parsePartnerKeyCommand(["list"]), { mode: "list" });
  const id = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(parsePartnerKeyCommand(["set-policy", id, "internal"]), { mode: "set-policy", id, policy: { tier: "internal" } });
  assert.deepEqual(parsePartnerKeyCommand(["set-policy", id, "custom", "120", "10000"]), {
    mode: "set-policy", id, policy: { tier: "custom", requestsPerMinute: 120, requestsPerDay: 10000 },
  });
  assert.deepEqual(parsePartnerKeyCommand(["revoke", "00000000-0000-4000-8000-000000000001"]), { mode: "revoke", id: "00000000-0000-4000-8000-000000000001" });
  for (const args of [[], ["create"], ["create", "acme"], ["create", "ACME", "key"], ["create", "acme", ""],
    ["delete-key", "acme"], ["delete-partner", "../acme"], ["delete-key", "00000000-0000-4000-8000-000000000001", "extra"],
    ["list", "extra"], ["revoke", "bad"], ["set-origins"], ["create-partner", "acme", "*"],
    ["set-origins", "acme", "http://example.com"], ["set-origins", "acme", "https://example.com/"],
    ["set-origins", "acme", "https://example.com", "https://example.com"],
    ["set-policy", id, "internal", "100"], ["set-policy", id, "custom", "0", "10"],
    ["set-policy", id, "custom", "Infinity", "10"],
    ["set-policy", id, "custom", "1e3", "10000"], ["set-policy", id, "custom", "0x10", "100"],
    ["set-policy", id, "custom", " 12 ", "100"], ["set-policy", id, "custom", "20", "10"], ["set-policy", id, "custom", "2", "2147483648"],
  ]) assert.throws(() => parsePartnerKeyCommand(args), (error) => error instanceof OperatorError && error.code === "OPERATOR_INPUT_INVALID");
  assert.equal(partnerOriginsSchema.safeParse(["https://user:password@example.com"]).success, false);
});

test("operator identity reaches every mutation; missing targets are explicit", async () => {
  const token = "test-operator-token-at-least-thirty-two-chars";
  const operator = new OperatorAuthenticator({ operatorId: "test-ops", tokenHash: createHash("sha256").update(token).digest("hex") }).authenticate("test-ops", token);
  const calls: unknown[][] = [];
  const partner = { id: "acme", origins: [], created_at: new Date(), created_by: "operator:test-ops", updated_at: new Date(), updated_by: "operator:test-ops" };
  const key = { id: "00000000-0000-4000-8000-000000000001", partner_id: "acme", label: "frontend", issued_by: "operator:test-ops", created_at: new Date(), revoked_at: null, revoked_by: null, tier: "standard" as const, requests_per_minute: 300, requests_per_day: 50_000, policy_updated_at: new Date(), policy_updated_by: "operator:test-ops" };
  const ports: PartnerKeyPorts = {
    deleteKey: async (...args) => { calls.push(["delete-key", ...args]); return true; },
    deletePartner: async (...args) => { calls.push(["delete-partner", ...args]); return true; },
    setPolicy: async () => key,
    createPartner: async (...args) => { calls.push(["partner", ...args]); return partner; },
    setOrigins: async (...args) => { calls.push(["origins", ...args]); return partner; },
    issue: async (...args) => { calls.push(["issue", ...args]); return { ...key, key: "only-issued-once" }; },
    revoke: async (...args) => { calls.push(["revoke", ...args]); return key; },
    list: async () => ({ partners: [partner], keys: [key] }),
  };
  for (const args of [["create-partner", "acme"], ["set-origins", "acme"], ["create", "acme", "frontend"], ["revoke", key.id], ["delete-key", key.id], ["delete-partner", "acme"]]) {
    await runPartnerKeyCommand(parsePartnerKeyCommand(args), operator, ports);
  }
  for (const call of calls) assert.equal(call.at(-1), "operator:test-ops");
  assert.equal(JSON.stringify(await runPartnerKeyCommand({ mode: "list" }, operator, ports)).includes("only-issued-once"), false);
  for (const command of [parsePartnerKeyCommand(["revoke", key.id]), parsePartnerKeyCommand(["set-origins", "acme"])]) {
    await assert.rejects(runPartnerKeyCommand(command, operator, { ...ports, revoke: async () => null, setOrigins: async () => null }),
      (error) => error instanceof OperatorError && error.code === "OPERATOR_TARGET_NOT_FOUND");
  }
});

test("the verifier never caches authorization and checks only a hash on the primary port", async () => {
  let active = true;
  let count = 0;
  const key = generatePartnerApiKey();
  const client = {
    query: async (text: string, values?: unknown[]) => {
      count++;
      assert.match(text, /^BEGIN READ ONLY;/);
      assert.match(text, /SET LOCAL lock_timeout = 100(?:;|$)/);
      assert.ok(text.includes("k.revoked_at IS NULL"));
      assert.ok(text.includes(`decode('${hashPartnerApiKey(key).toString("hex")}', 'hex')`));
      assert.equal(values, undefined);
      assert.equal(text.includes(key), false);
      return [{ command: "BEGIN" }, { command: "SET" }, {
        command: "SELECT", rows: active ? [{ id: "acme", origins: [], keyId: "00000000-0000-4000-8000-000000000001", policy: { tier: "standard" } }] : [],
      }, { command: "COMMIT" }];
    },
    on() {}, release() {}, removeListener() {},
  };
  const reader = createPartnerKeyReader(() => ({ connect: async () => client }) as unknown as Pool);
  assert.equal(await reader.verify("invalid"), null);
  assert.equal(count, 0);
  assert.equal((await reader.verify(key))?.id, "acme");
  assert.equal((await reader.verify(key))?.id, "acme");
  active = false;
  assert.equal(await reader.verify(key), null);
  assert.equal(count, 3);
});

test("CLI rejects an unauthenticated operator before opening a database connection", () => {
  assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", new URL("../../scripts/partner-api-keys.ts", import.meta.url).pathname, "list"], {
    env: { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: "postgres://invalid", MISSION_CONTROL_OPERATOR_ALLOWED_ID: "test-ops", MISSION_CONTROL_OPERATOR_TOKEN_SHA256: "0".repeat(64), BLAST_OPERATOR_ID: "test-ops", BLAST_OPERATOR_TOKEN: "wrong-token-with-at-least-thirty-two-chars" },
    stdio: "pipe",
  }), (error: unknown) => {
    const failed = error as { stderr: Buffer; stdout: Buffer; status: number };
    assert.equal(failed.status, 1);
    assert.equal(failed.stdout.toString(), "");
    assert.ok(failed.stderr.toString().includes('"code":"OPERATOR_AUTH_FAILED"'));
    return true;
  });
});
