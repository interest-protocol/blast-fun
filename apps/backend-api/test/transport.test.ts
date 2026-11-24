import assert from "node:assert/strict";
import { once } from "node:events";
import { Agent, createServer, request } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { ingressTrust } from "@blast/core/lib/web-security/ingress.ts";
import { signGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import { createBackendRelay } from "../../web/src/modules/partner-api/v1/relay.ts";
import { createBackendServer } from "../src/app/server.ts";

test("hot keep-alive sockets survive beyond one thousand reads without quota-retry ambiguity", async (t) => {
  let handled = 0;
  let connections = 0;
  const runtime = createBackendServer({
    gatewaySecret: "test-only-gateway-secret-01234567890123456789",
    namespace: "test",
    redis: {
      async execute() {
        throw new Error("Direct fixture requests need no gateway Redis.");
      },
    },
    ready: async () => true,
    async handle() {
      handled++;
      return Response.json({ ok: true });
    },
  });

  const origin = `http://127.0.0.1:${runtime.server.port}`;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(async () => {
    agent.destroy();
    await runtime.drain();
  });
  for (let index = 0; index < 1_101; index++) {
    const answer = request(origin + "/api/v1/market/status", { agent });
    const response = once(answer, "response");
    answer.end();
    const [incoming] = await response;
    if (!answer.reusedSocket) {
      connections++;
    }
    let text = "";
    for await (const chunk of incoming) {
      text += chunk;
    }
    assert.equal(incoming.statusCode, 200);
    assert.deepEqual(JSON.parse(text), { ok: true });
  }
  assert.equal(handled, 1_101);
  assert.equal(connections, 1, "No forced rollover closes a pooled read socket.");
});

test("compressed upstream responses survive the frontend relay with correct wire headers and cookies", async (t) => {
  const compressed = gzipSync('{"compressed":true}');
  let encoding: string | undefined;
  const upstream = createServer((incoming, outgoing) => {
    encoding = incoming.headers["accept-encoding"];
    outgoing.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": String(compressed.length),
      Connection: "keep-alive, x-fixture-hop",
      "X-Fixture-Hop": "private-transport",
      "Cache-Control": "public, max-age=0, s-maxage=10",
      "Set-Cookie": ["wallet=; Max-Age=0; HttpOnly", "wallet_hint=; Max-Age=0"],
    });
    outgoing.end(compressed);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const relay = createBackendRelay(
    `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    "synthetic-gateway-secret-01234567890123456789",
    { namespace: "a".repeat(64), clientAddress: () => "192.0.2.1" },
  );
  const runtime = createBackendServer({
    gatewaySecret: "unused-synthetic-secret-01234567890123456789",
    namespace: "a".repeat(64),
    redis: {
      async execute() {
        throw new Error("Direct frontend requests need no gateway Redis.");
      },
    },
    ready: async () => true,
    handle: (incoming) =>
      relay(
        new Request("https://frontend.test/api/v1/market/status", {
          headers: incoming.headers,
        }),
      ),
  });

  t.after(async () => {
    await runtime.drain();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const response = await fetch(`http://127.0.0.1:${runtime.server.port}/api/v1/market/status`);
  assert.equal(response.status, 200);
  const responseText = await response.text();
  assert.deepEqual(JSON.parse(responseText), { compressed: true });
  assert.equal(encoding, "identity", "A proxy that still compresses must also be handled safely.");
  for (const header of ["content-encoding", "x-fixture-hop"]) {
    assert.equal(response.headers.get(header), null, header);
  }
  const length = response.headers.get("content-length");
  if (length !== null) {
    assert.equal(
      Number(length),
      Buffer.byteLength(responseText),
      "A native computed length must describe the decompressed wire body.",
    );
    assert.notEqual(
      Number(length),
      compressed.length,
      "The compressed upstream length must not survive decompression.",
    );
  }
  assert.equal(response.headers.get("cache-control"), "public, max-age=0, s-maxage=10");
  assert.equal(response.headers.getSetCookie().length, 2);
});

test("backend deadlines preserve family codes before the frontend relay deadline", async (t) => {
  const secret = "synthetic-gateway-secret-01234567890123456789";
  const namespace = "a".repeat(64);
  const runtime = createBackendServer({
    gatewaySecret: secret,
    namespace,
    redis: {
      async execute() {
        return "OK";
      },
    },
    ready: async () => true,
    handle: (incoming) =>
      new Promise<Response>((resolve) =>
        incoming.signal.addEventListener("abort", () => resolve(Response.json({ late: true })), {
          once: true,
        }),
      ),
  });
  t.after(() => runtime.drain());
  const origin = `http://127.0.0.1:${runtime.server.port}`;
  const relay = createBackendRelay(origin, secret, {
    namespace,
    clientAddress: () => "198.51.100.10",
    firstParty: true,
  });
  const answers = await Promise.all([
    relay(
      new Request("https://frontend.test/api/launchpad/market/status", {
        headers: { "x-forwarded-for": "198.51.100.10" },
      }),
    ),
    relay(
      new Request("https://frontend.test/api/social/prices", {
        headers: { "x-forwarded-for": "198.51.100.10" },
      }),
    ),
    relay(
      new Request("https://frontend.test/api/launchpad/discovery", {
        headers: { "x-forwarded-for": "198.51.100.10" },
      }),
    ),
    fetch(origin + "/api/v1/market/status"),
  ]);
  for (const [index, code] of [
    "unavailable",
    "service_unavailable",
    "LAUNCHPAD_READ_UNAVAILABLE",
    "service_unavailable",
  ].entries()) {
    assert.equal(answers[index].status, 503);
    assert.ok(
      answers[index].headers.get("x-request-id"),
      "The backend responds before the relay's five-second abort fallback.",
    );
    assert.equal((await answers[index].json()).error.code, code);
    assert.equal(answers[index].headers.get("retry-after"), "5");
  }
});

test("ambiguous trusted forwarding is refused before any admission or handler work", async (t) => {
  let handled = 0;
  const runtime = createBackendServer({
    gatewaySecret: "synthetic-gateway-secret-01234567890123456789",
    namespace: "a".repeat(64),
    ingress: ingressTrust({
      BLAST_BACKEND_INGRESS_MODE: "trusted-proxy",
      BLAST_BACKEND_TRUSTED_PROXY_CIDRS: "127.0.0.1/32",
    }),
    redis: {
      async execute() {
        return "OK";
      },
    },
    ready: async () => true,
    async handle(incoming, client) {
      handled++;
      assert.equal(incoming.headers.get("x-forwarded-for"), null);
      assert.equal(incoming.headers.get("x-real-ip"), null);
      return Response.json({ ip: client.address });
    },
  });
  t.after(() => runtime.drain());
  const origin = `http://127.0.0.1:${runtime.server.port}/api/v1/market/status`;
  for (const ip of [undefined, "unavailable", "203.0.113.1, 203.0.113.2"]) {
    const response = await fetch(origin, {
      headers: ip ? { "x-forwarded-for": ip } : {},
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "service_unavailable");
  }
  const unknown = new Request(origin);
  const signedUnknown = await fetch(origin, {
    headers: signGatewayRequest(
      unknown,
      "synthetic-gateway-secret-01234567890123456789",
      "unavailable",
      "a".repeat(64),
    ),
  });
  assert.equal(signedUnknown.status, 503);
  await signedUnknown.body?.cancel();
  assert.equal(handled, 0);
  const response = await fetch(origin, {
    headers: { "x-forwarded-for": "203.0.113.1" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ip: "203.0.113.1" });
  assert.equal(handled, 1);
});
