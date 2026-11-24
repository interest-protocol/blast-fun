import assert from "node:assert/strict";
import test from "node:test";
import { signGatewayRequest } from "./gateway.ts";
import {
  PRIVATE_PROOF_TTL_SECONDS,
  signPrivateRequest,
  stripPrivateHeaders,
  verifyPrivateRequest,
} from "./private-gateway.ts";
import { privateRoute } from "./private-routes.ts";

const secret = "synthetic-private-gateway-secret-01234567890123456789";
const namespace = "a".repeat(64);
const siteOrigin = "https://frontend.test";
const now = 1792928000000;
const body = new TextEncoder().encode(
  '{"private":true,"explorer":"suivision"}',
);
function request(
  path = "/api/social/me/settings",
  method = "PUT",
  bytes = body,
) {
  return new Request(siteOrigin + path, {
    method,
    headers: {
      authorization: "Bearer synthetic.jwt.token",
      cookie: "__Host-blast_wallet=existing-token",
      origin: siteOrigin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    ...(method === "GET" ? {} : { body: bytes }),
  });
}
function signed(input = request(), bytes = body) {
  return new Request(input, {
    headers: signPrivateRequest(
      input,
      bytes,
      secret,
      { namespace, purpose: "browser", siteOrigin, ip: "192.0.2.1" },
      now,
    ),
  });
}
function verify(input: Request, bytes = body, clock = now) {
  return verifyPrivateRequest(
    input,
    bytes,
    secret,
    { namespace, siteOrigin },
    clock,
  );
}

test("private proof binds exact byte body, target/query and original credentials/security metadata", () => {
  const original = signed(request("/api/social/me/settings?x=1&x=2"));
  assert.equal(verify(original)?.route.id, "social.settings.write");
  assert.equal(
    verify(original, new TextEncoder().encode('{"private":false}')),
    null,
  );
  for (const [name, value] of [
    ["authorization", "Bearer different"],
    ["cookie", "__Host-blast_wallet=different"],
    ["origin", "https://other.test"],
    ["sec-fetch-site", "cross-site"],
    ["content-type", "text/plain"],
    ["x-csrf-token", "mutated"],
    ["x-blast-csrf", "mutated"],
    ["x-bot-challenge", "mutated"],
    ["idempotency-key", "mutated"],
    ["x-blast-api-key", "mutated"],
    ["x-blast-public-view", "1"],
    ["x-blast-private-purpose", "ssr-read"],
    ["x-blast-private-siteorigin", "https://other.test"],
    ["x-blast-private-namespace", "b".repeat(64)],
    ["x-blast-private-ip", "192.0.2.2"],
    ["x-blast-private-nonce", "a".repeat(32)],
    ["x-blast-private-bodysha256", "0".repeat(64)],
  ]) {
    const headers = new Headers(original.headers);
    headers.set(name, value);
    assert.equal(
      verify(
        new Request(original.url, { method: original.method, headers, body }),
      ),
      null,
      name,
    );
  }
  assert.equal(
    verify(
      new Request(siteOrigin + "/api/social/me/settings?x=2&x=1", {
        method: "PUT",
        headers: original.headers,
        body,
      }),
    ),
    null,
  );
  assert.equal(
    verify(
      new Request(original.url, {
        method: "POST",
        headers: original.headers,
        body,
      }),
    ),
    null,
  );
  const noOrigin = new Headers(original.headers);
  noOrigin.delete("origin");
  assert.equal(
    verify(
      new Request(original.url, {
        method: original.method,
        headers: noOrigin,
        body,
      }),
    ),
    null,
    "Absent and present Origin differ",
  );
});

test("private proof cannot cross public/operator namespaces, route methods, purpose or acceptance interval", () => {
  const input = request();
  const publicHeaders = signGatewayRequest(
    input,
    secret,
    "192.0.2.1",
    namespace,
    now,
  );
  assert.equal(verify(new Request(input, { headers: publicHeaders })), null);
  assert.equal(verify(signed(), body, now + 15001), null);
  assert.equal(verify(signed(), body, now - 2001), null);
  assert.ok(verify(signed(), body, now + 15000));
  assert.ok(verify(signed(), body, now - 2000));
  assert.ok(
    PRIVATE_PROOF_TTL_SECONDS * 1000 >= 17000,
    "Nonce cannot expire while future-skew proof remains valid",
  );
  assert.throws(() =>
    signPrivateRequest(
      input,
      body,
      secret,
      { namespace, purpose: "ssr-read", siteOrigin, ip: "192.0.2.1" },
      now,
    ),
  );
  assert.equal(
    privateRoute("GET", "/api/social/me", "ssr-read")?.id,
    "social.me",
  );
  assert.equal(
    privateRoute("GET", "/api/social/me/settings", "ssr-read"),
    null,
  );
  assert.equal(
    privateRoute("POST", "/api/admin/partner-keys", "browser"),
    null,
  );
});

test("closed route contracts preserve sign-in proof boundary and reject oversized or ambiguous transport", () => {
  for (const size of [12287, 12288]) {
    const bytes = new Uint8Array(size);
    assert.ok(
      signed(request("/api/social/sign-in/session", "POST", bytes), bytes),
    );
  }
  for (const [path, size] of [
    ["/api/social/sign-in/session", 12289],
    ["/api/social/me/wallets", 4097],
  ] as const) {
    const bytes = new Uint8Array(size);
    assert.throws(() => signed(request(path, "POST", bytes), bytes));
  }
  for (const [name, value] of [
    ["origin", `${siteOrigin}, https://other.test`],
    ["content-encoding", "gzip"],
    ["x-blast-partner-key", `blast_pk_${"a".repeat(43)}`],
  ]) {
    const input = request();
    input.headers.set(name, value);
    assert.throws(() => signed(input), name);
  }
  assert.throws(() =>
    signed(request("/api/social/callsigns/%2fadmin", "GET"), new Uint8Array()),
  );
  const headers = new Headers({
    "x-blast-private-signature": "forged",
    "x-blast-gateway-signature": "forged",
    "x-blast-internal-user": "forged",
    "x-forwarded-for": "forged",
    cookie: "kept",
  });
  stripPrivateHeaders(headers);
  assert.deepEqual([...headers], [["cookie", "kept"]]);
});

test("signer, verifier and route registry use the same normalized Request target", () => {
  const input = new Request(siteOrigin + "/api/social/obsolete/../me?x=1&x=2", {
    method: "HEAD",
  });
  assert.equal(new URL(input.url).pathname, "/api/social/me");
  const bytes = new Uint8Array();
  const headers = signPrivateRequest(
    input,
    bytes,
    secret,
    { namespace, purpose: "browser", siteOrigin, ip: "192.0.2.1" },
    now,
  );
  const verified = verifyPrivateRequest(
    new Request(input.url, { method: "HEAD", headers }),
    bytes,
    secret,
    { namespace, siteOrigin },
    now,
  );
  assert.equal(verified?.route.id, "social.me");
  assert.equal(verified?.route.method, "HEAD");
  assert.equal(
    privateRoute("HEAD", new URL(input.url).pathname, "browser"),
    verified?.route,
  );
});
