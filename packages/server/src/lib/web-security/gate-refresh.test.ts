import assert from "node:assert/strict";
import test from "node:test";
import { gateKeys, mintGateToken, gateTokenIssuedAt } from "@blast/core/lib/web-security/gate-cookie.ts";
import { gateRefreshResponse } from "./gate-refresh.ts";
import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";

const origin = "https://frontend.test";
const key = "synthetic-shared-gate-key-012345678901";
const request = () => new Request(origin + "/api/gate", { headers: { origin, "sec-fetch-site": "same-origin" } });

test("refresh refuses a foreign origin before it touches the store", async () => {
  let stores = 0;
  const answer = await gateRefreshResponse(new Request(origin + "/api/gate", { headers: { origin: "https://foreign.test", "sec-fetch-site": "same-origin" } }), testClient(), { expectedOrigin: origin, keys: gateKeys({ BLAST_GATE_SECRET: key })!, limiter: async () => { stores++; return null; } });
  assert.equal(answer.status, 403); assert.equal(stores, 0);
  assert.equal(answer.headers.get("set-cookie"), null);
});

test("shared refresh signs the existing wire format while current and previous keys retain exact lifetime", async () => {
  const now = 1_790_000_000_000;
  const old = "synthetic-previous-gate-key-01234567890";
  const environment = { NODE_ENV: "production", BLAST_GATE_SECRET: key, BLAST_GATE_SECRET_PREVIOUS: old };
  let consumes = 0;
  const answer = await gateRefreshResponse(request(), testClient(), { expectedOrigin: origin, keys: gateKeys(environment)!, now, limiter: async () => ({
    async consume(bucket, subject) {
      assert.equal(bucket, "web_gate"); assert.deepEqual(Object.keys(subject), ["ip"]); consumes++;
      return { allowed: true, bucket, policyVersion: 1, retryAfterSeconds: 0 };
    },
  }) });
  assert.equal(answer.status, 204); assert.equal(consumes, 1);
  const token = answer.headers.get("set-cookie")!.split(";", 1)[0].split("=")[1];
  assert.equal(gateTokenIssuedAt(token, gateKeys(environment)!, now), now / 1000);
  const oldToken = mintGateToken(gateKeys({ BLAST_GATE_SECRET: old })!, now);
  assert.equal(gateTokenIssuedAt(oldToken, gateKeys(environment)!, now), now / 1000);
  assert.equal(gateTokenIssuedAt(oldToken, gateKeys(environment)!, now + 7_200_000), null);
  assert.match(answer.headers.get("set-cookie")!, /^__Host-blast_gate=v1\./);
  assert.match(answer.headers.get("set-cookie")!, /Max-Age=7200; HttpOnly; Secure; SameSite=Lax$/);
});
