import assert from "node:assert/strict";
import test from "node:test";
import {
  signGatewayRequest,
  verifyGatewayRequest,
} from "@blast/core/modules/backend-api/gateway.ts";

const secret = "synthetic-gateway-secret-01234567890123456789";
const namespace = "a".repeat(64);
const now = Date.now();
const original = new Request("http://local/internal/public-read/api/v1/prices?coin=x", {
  headers: {
    authorization: "Bearer synthetic-session",
    "x-blast-gateway-ip": "spoofed",
    "x-forwarded-for": "192.0.2.1",
  },
});
const signed = new Request(original, {
  headers: signGatewayRequest(original, secret, "198.51.100.7", namespace, now),
});
test("gateway proof binds request target, credentials, client address and expiry", () => {
  assert.equal(verifyGatewayRequest(signed, secret, namespace, now)?.ip, "198.51.100.7");
  assert.equal(
    verifyGatewayRequest(signed, secret, "b".repeat(64), now),
    null,
    "A preview proof cannot enter a production quota namespace.",
  );
  assert.equal(signed.headers.has("x-forwarded-for"), false);
  assert.equal(verifyGatewayRequest(signed, secret, namespace, now + 20_000), null);
  assert.equal(
    verifyGatewayRequest(new Request(signed.url + "extra", signed), secret, namespace, now),
    null,
  );
  const changed = new Headers(signed.headers);
  changed.set("authorization", "Bearer forged");
  assert.equal(
    verifyGatewayRequest(new Request(signed.url, { headers: changed }), secret, namespace, now),
    null,
  );
  changed.set("x-blast-gateway-ip", "203.0.113.6");
  assert.equal(
    verifyGatewayRequest(new Request(signed.url, { headers: changed }), secret, namespace, now),
    null,
  );
});
