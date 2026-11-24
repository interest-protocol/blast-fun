import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createPrivyTokenVerifier } from "./token-verifier.ts";

const NOW = 2_000_000_000;
const APP_ID = "privy-verifier-test";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKey = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
const options = { appId: APP_ID, verificationKey, now: () => NOW };

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = keys.privateKey,
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const protectedHeader = encode({ alg: "ES256", typ: "JWT", ...header });
  const payload = encode({ aud: APP_ID, exp: NOW + 60, iat: NOW - 60, iss: "privy.io", sid: "session", sub: "did:privy:member", ...claims });
  const signature = sign("sha256", Buffer.from(`${protectedHeader}.${payload}`), { dsaEncoding: "ieee-p1363", key });
  return `${protectedHeader}.${payload}.${signature.toString("base64url")}`;
}

test("verifies a pinned P-256 signature and preserves the Privy claim contract", async () => {
  const verify = createPrivyTokenVerifier(options);
  assert.deepEqual(await verify(token()), {
    appId: APP_ID, expiration: NOW + 60, issuedAt: NOW - 60, issuer: "privy.io", sessionId: "session", userId: "did:privy:member",
  });
  const forged = generateKeyPairSync("ec", { namedCurve: "P-256" });
  for (const invalid of ["not-a-jwt", token({}, {}, forged.privateKey), token({}, { alg: "HS256" }), token() + ".", "x".repeat(16_385)]) {
    await assert.rejects(verify(invalid), { code: "INVALID_ACCESS_TOKEN" });
  }
  for (const claims of [
    { aud: [APP_ID] }, { aud: "another-app" }, { iss: "another-issuer" },
    { exp: undefined }, { exp: -1 }, { exp: NOW + 0.5 }, { exp: Number.MAX_SAFE_INTEGER + 1 },
    { iat: undefined }, { iat: -1 }, { iat: NOW - 0.5 }, { iat: Number.MAX_SAFE_INTEGER + 1 }, { iat: NOW + 1 },
    { sid: "" }, { sid: 1 }, { sub: "another-provider:member" }, { sub: 1 },
    { exp: NOW - 1, sid: "" },
  ]) {
    await assert.rejects(verify(token(claims)), { code: "INVALID_ACCESS_TOKEN" }, JSON.stringify(claims));
  }
});

test("enforces JWT not-before and critical headers instead of ignoring them", async () => {
  const verify = createPrivyTokenVerifier(options);
  for (const invalid of [
    token({ nbf: NOW + 1 }), token({ nbf: "tomorrow" }),
    token({}, { crit: ["unsupported"], unsupported: true }),
    token({}, { crit: ["b64"], b64: false }),
  ]) {
    await assert.rejects(verify(invalid), { code: "INVALID_ACCESS_TOKEN" });
  }
  await verify(token({ nbf: NOW }));
});

test("preserves expiry errors and clock-skew boundaries", async () => {
  const verify = createPrivyTokenVerifier(options);
  await assert.rejects(verify(token({ exp: NOW })), { code: "ACCESS_TOKEN_EXPIRED" });
  const tolerant = createPrivyTokenVerifier({ ...options, clockSkewSeconds: 5 });
  await tolerant(token({ exp: NOW - 4, iat: NOW + 5, nbf: NOW + 5 }));
  await assert.rejects(tolerant(token({ exp: NOW - 5 })), { code: "ACCESS_TOKEN_EXPIRED" });
  await assert.rejects(tolerant(token({ iat: NOW + 6 })), { code: "INVALID_ACCESS_TOKEN" });
  await assert.rejects(tolerant(token({ nbf: NOW + 6 })), { code: "INVALID_ACCESS_TOKEN" });
});

test("refuses invalid configuration synchronously and accepts escaped PEM newlines", async () => {
  const wrongCurve = generateKeyPairSync("ec", { namedCurve: "P-384" });
  for (const invalid of [
    { appId: "" }, { clockSkewSeconds: -1 }, { clockSkewSeconds: 0.5 },
    { verificationKey: "not-a-key" },
    { verificationKey: wrongCurve.publicKey.export({ format: "pem", type: "spki" }).toString() },
  ]) {
    assert.throws(() => createPrivyTokenVerifier({ ...options, ...invalid }), { code: "INVALID_CONFIGURATION" });
  }
  await createPrivyTokenVerifier({ ...options, verificationKey: verificationKey.replaceAll("\n", "\\n") })(token());
});
