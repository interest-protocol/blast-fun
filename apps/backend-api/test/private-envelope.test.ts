import assert from "node:assert/strict";
import test from "node:test";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { privateRequest } from "../src/transport/private.ts";

const secret = "synthetic-private-envelope-secret-0123456789";
const namespace = "a".repeat(64);
const siteOrigin = "https://frontend.test";
const url = siteOrigin + "/api/social/me/settings";
const bytes = new TextEncoder().encode('{"private":true}');

function headers(body = bytes) {
  const source = new Request(url, {
    method: "PUT",
    headers: { origin: siteOrigin, "content-type": "application/json" },
    body,
  });
  return signPrivateRequest(source, body, secret, {
    namespace,
    purpose: "browser",
    siteOrigin,
    ip: "192.0.2.1",
  });
}

function fixture() {
  let nonces = 0;
  let business = 0;
  const run = (request: Request) =>
    privateRequest(
      request,
      privateRoute("PUT", "/api/social/me/settings", "browser")!,
      {
        namespace,
        gatewaySecret: secret,
        redis: {
          async execute() {
            nonces++;
            return "OK";
          },
        },
        privateApi: {
          siteOrigin,
          async handle(request) {
            business++;
            return new Response(await request.arrayBuffer());
          },
        },
      },
      new AbortController().signal,
    );
  return { run, counts: () => ({ nonces, business }) };
}

function streamed(proof: Headers, body: ReadableStream<Uint8Array>) {
  return new Request(url, {
    method: "PUT",
    headers: proof,
    body,
    duplex: "half",
  } as RequestInit);
}

test("invalid or ambiguous proof refuses before pulling a never-ending body", async () => {
  for (const mutate of [
    (h: Headers) => h.set("x-blast-private-signature", "a".repeat(43)),
    (h: Headers) => h.delete("x-blast-private-bodysha256"),
    (h: Headers) => h.append("x-blast-private-bodysha256", "a".repeat(64)),
    (h: Headers) => h.append("x-blast-private-siteorigin", siteOrigin),
  ]) {
    const f = fixture();
    let pulls = 0;
    const proof = headers();
    mutate(proof);
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulls++;
        },
      },
      { highWaterMark: 0 },
    );
    const response = await f.run(streamed(proof, body));
    assert.equal(response.status, 403);
    assert.equal(pulls, 0);
    assert.deepEqual(f.counts(), { nonces: 0, business: 0 });
    await body.cancel();
  }
});

test("a valid envelope with different actual bytes cannot burn a nonce or enter business handling", async () => {
  const f = fixture();
  const response = await f.run(
    new Request(url, {
      method: "PUT",
      headers: headers(),
      body: '{"private":false}',
    }),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(f.counts(), { nonces: 0, business: 0 });
});

test("valid-envelope slow and oversized bodies retain deadline and byte bounds", async () => {
  const f = fixture();
  let cancelled = false;
  const slow = new ReadableStream<Uint8Array>(
    {
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(f.run(streamed(headers(), slow)), {
    name: "TimeoutError",
  });
  assert.equal(cancelled, true);
  const large = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4097));
      controller.close();
    },
  });
  await assert.rejects(
    f.run(streamed(headers(), large)),
    (error: unknown) => error instanceof Response && error.status === 413,
  );
  assert.deepEqual(f.counts(), { nonces: 0, business: 0 });
});

test("multipart bytes and boundary survive authenticated transport exactly", async () => {
  const f = fixture();
  const body = new TextEncoder().encode(
    '--boundary\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\u0000\u0001\u00ff\r\n--boundary--\r\n',
  );
  const original = new Request(url, {
    method: "PUT",
    headers: {
      "content-type": "multipart/form-data; boundary=boundary",
      origin: siteOrigin,
    },
    body,
  });
  const proof = signPrivateRequest(original, body, secret, {
    namespace,
    purpose: "browser",
    siteOrigin,
    ip: "192.0.2.1",
  });
  const response = await f.run(new Request(url, { method: "PUT", headers: proof, body }));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
  assert.deepEqual(f.counts(), { nonces: 1, business: 1 });
});
