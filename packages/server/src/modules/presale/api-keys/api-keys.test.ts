import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";

import type { Pool } from "pg";

import { OperatorAuthenticator } from "@blast/server/modules/mission-control/operator/auth.ts";
import { OperatorError } from "@blast/server/modules/mission-control/operator/errors.ts";
import { createPresaleApiKeyVerifier, PRESALE_API_KEY_MISS_TTL_MS } from "./repository.ts";
import { parseApiKeyCommand, runApiKeyCommand, type ApiKeyPorts } from "./command.ts";
import { generatePresaleApiKey, hashPresaleApiKey, isPresaleApiKey } from "./keys.ts";

/** T-013 (AC-062, AC-063): agent API keys are random, kept as SHA-256 only, and issued by an operator command. */

test("a key is blast_ak_ and 43 base64url characters, fresh each time", () => {
  const keys = new Set(Array.from({ length: 50 }, generatePresaleApiKey));
  assert.equal(keys.size, 50);
  for (const key of keys) {
    assert.match(key, /^blast_ak_[A-Za-z0-9_-]{43}$/);
    assert.equal(isPresaleApiKey(key), true);
  }
  for (const other of ["", "blast_ak_", `blast_ak_${"A".repeat(42)}`, `blast_ak_${"A".repeat(44)}`, `blast_ak_${"A".repeat(42)}=`, `x${"A".repeat(51)}`]) {
    assert.equal(isPresaleApiKey(other), false, other);
  }
});

test("a key is stored as the SHA-256 of the whole key", () => {
  assert.equal(
    hashPresaleApiKey(`blast_ak_${"A".repeat(43)}`).toString("hex"),
    "d2ea3220f646df5f20de4a1acc699cda31987b336106917b32b2706600cc8df2",
  );
});

test("the operator command is create <label>, revoke <id> or list, exactly", () => {
  const id = "0b0f8c4e-3a5b-4c1e-9f7a-2d6e8b1c4a90";
  assert.deepEqual(parseApiKeyCommand(["create", "research-agent"]), { mode: "create", label: "research-agent" });
  assert.deepEqual(parseApiKeyCommand(["revoke", id]), { mode: "revoke", id });
  assert.deepEqual(parseApiKeyCommand(["list"]), { mode: "list" });
  for (const args of [
    [],
    ["create"],
    ["create", ""],
    ["create", "-dash-first"],
    ["create", "x".repeat(101)],
    ["create", "a", "b"],
    ["revoke", "not-a-uuid"],
    ["revoke", id.toUpperCase()],
    ["list", "extra"],
    ["delete", id],
  ]) {
    assert.throws(() => parseApiKeyCommand(args), (error: unknown) =>
      error instanceof OperatorError && error.code === "OPERATOR_INPUT_INVALID", args.join(" "));
  }
});

test("issuing and revoking a key name the authenticated operator; listing names none", async () => {
  const token = "api-key-operator-fixture-token-0123456789";
  const operator = new OperatorAuthenticator({
    operatorId: "presale-ops",
    tokenHash: createHash("sha256").update(token).digest("hex"),
  }).authenticate("presale-ops", token);
  const calls: unknown[][] = [];
  const key = { id: "0b0f8c4e-3a5b-4c1e-9f7a-2d6e8b1c4a90", label: "agent", createdAt: "2026-10-02T00:00:00.000Z" };
  const ports: ApiKeyPorts = {
    async issue(label, issuedBy) {
      calls.push(["issue", label, issuedBy]);
      return { ...key, issuedBy, revokedAt: null, revokedBy: null, key: "blast_ak_x" };
    },
    async revoke(id, revokedBy) {
      calls.push(["revoke", id, revokedBy]);
      return id === key.id ? { ...key, issuedBy: revokedBy, revokedAt: key.createdAt, revokedBy } : null;
    },
    async list() {
      calls.push(["list"]);
      return [];
    },
  };
  await runApiKeyCommand({ mode: "create", label: "agent" }, operator, ports);
  await runApiKeyCommand({ mode: "revoke", id: key.id }, operator, ports);
  await runApiKeyCommand({ mode: "list" }, operator, ports);
  assert.deepEqual(calls, [
    ["issue", "agent", "operator:presale-ops"],
    ["revoke", key.id, "operator:presale-ops"],
    ["list"],
  ]);
  await assert.rejects(
    runApiKeyCommand({ mode: "revoke", id: "1b0f8c4e-3a5b-4c1e-9f7a-2d6e8b1c4a90" }, operator, ports),
    (error: unknown) => error instanceof OperatorError && error.code === "OPERATOR_TARGET_NOT_FOUND",
  );
});

/** A pool whose one key is `known`; it counts the lookups that reach it. */
function keyPool(known: string) {
  const state = { lookups: 0, revoked: false };
  const client = {
    async query(config: { text: string; values: unknown[] }) {
      state.lookups += 1;
      const match = !state.revoked && Buffer.from(config.values[0] as Buffer).equals(hashPresaleApiKey(known));
      return { rows: match ? [{ id: "0b0f8c4e-3a5b-4c1e-9f7a-2d6e8b1c4a90" }] : [] };
    },
    on() {},
    release() {},
    removeListener() {},
  };
  return { state, pool: { connect: async () => client } as unknown as Pool };
}

test("review M2: an unknown key is remembered as a miss for a minute; a known key and a revocation are never cached", async () => {
  const known = generatePresaleApiKey();
  const forged = generatePresaleApiKey();
  const fake = keyPool(known);
  let now = 1_000_000;
  const verify = createPresaleApiKeyVerifier(() => fake.pool, { now: () => now, missEntries: 2 });
  assert.equal(await verify("not-a-key"), null);
  assert.equal(fake.state.lookups, 0, "a value without a key's shape is refused unread");
  assert.equal(await verify(forged), null);
  assert.equal(await verify(forged), null);
  assert.equal(fake.state.lookups, 1, "the same miss again is answered from memory");
  now += PRESALE_API_KEY_MISS_TTL_MS;
  assert.equal(await verify(forged), null);
  assert.equal(fake.state.lookups, 2, "after the TTL it is read again");
  assert.deepEqual(await verify(known), { keyId: "0b0f8c4e-3a5b-4c1e-9f7a-2d6e8b1c4a90", did: null });
  assert.deepEqual(await verify(known), { keyId: "0b0f8c4e-3a5b-4c1e-9f7a-2d6e8b1c4a90", did: null });
  assert.equal(fake.state.lookups, 4, "a known key is read every time");
  fake.state.revoked = true;
  assert.equal(await verify(known), null, "a revocation takes effect on the next request");
  // At most `missEntries` misses are kept, the oldest forgotten first.
  const others = [generatePresaleApiKey(), generatePresaleApiKey()];
  for (const key of others) await verify(key);
  const before = fake.state.lookups;
  await verify(known);
  assert.equal(fake.state.lookups, before + 1, "the oldest miss was forgotten");
  await verify(others[1]!);
  assert.equal(fake.state.lookups, before + 1, "a recent miss is still remembered");
});
