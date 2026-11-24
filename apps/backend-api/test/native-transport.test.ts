import assert from "node:assert/strict";
import { connect } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { signGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { createBackendServer } from "../src/app/server.ts";

const secret = "synthetic-gateway-secret-01234567890123456789";
const namespace = "a".repeat(64);
const adminToken = "synthetic-operator-admin-token-0123456789";
const operator = { authorization: `Bearer ${adminToken}` };
const redis = {
  async execute() {
    return "OK";
  },
};

function origin(server: ReturnType<typeof createBackendServer>["server"]) {
  return `http://127.0.0.1:${server.port}`;
}

async function rawHttp(port: number, wire: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Raw fixture timed out."));
    }, 6_000);
    socket.once("connect", () => socket.write(wire));
    socket.on("data", (chunk) => {
      response += chunk.toString();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

test("native Bun dispatch preserves socket identity, strips private headers and bounds admin bodies", async (t) => {
  const received: Array<{
    method: string;
    body: string;
    gateway: boolean;
    ip: string | null;
  }> = [];
  const runtime = createBackendServer({
    redis,
    namespace,
    gatewaySecret: secret,
    adminToken,
    ready: async () => true,
    async handle(request, client, gateway) {
      assert.equal(request.headers.get("x-blast-internal-user"), null);
      assert.equal(request.headers.get("x-real-ip"), null);
      assert.equal(request.headers.get("x-forwarded-for"), null);
      received.push({
        method: request.method,
        body: await request.text(),
        gateway,
        ip: client.address,
      });
      return Response.json({ accepted: true });
    },
  });
  t.after(() => runtime.drain());
  const base = origin(runtime.server);
  const publicRead = await fetch(base + "/api/v1/prices", {
    headers: {
      "x-forwarded-for": "203.0.113.9",
      "x-real-ip": "203.0.113.8",
      "x-blast-internal-user": "forged",
    },
  });
  assert.equal(publicRead.status, 200);
  await publicRead.body?.cancel();
  for (const method of ["POST", "PUT"]) {
    const response = await fetch(base + "/api/admin/partner-keys", {
      method,
      headers: operator,
      body: "x".repeat(8_192),
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  }
  assert.deepEqual(
    received.map(({ method, body, gateway, ip }) => [method, body.length, gateway, ip]),
    [
      ["GET", 0, false, "127.0.0.1"],
      ["POST", 8_192, false, "127.0.0.1"],
      ["PUT", 8_192, false, "127.0.0.1"],
    ],
  );
  const before = received.length;
  for (const method of ["DELETE", "PATCH", "OPTIONS", "HEAD"]) {
    const response = await fetch(base + "/api/admin/partner-keys", { method, headers: operator });
    assert.equal(response.status, 405);
    await response.body?.cancel();
  }
  const oversized = await fetch(base + "/api/admin/partner-keys", {
    method: "POST",
    headers: operator,
    body: "x".repeat(8_193),
  });
  assert.equal(oversized.status, 413);
  await oversized.body?.cancel();
  assert.equal(received.length, before, "Rejected methods and bodies cannot reach admin code.");
});

test("a valid read gateway proof cannot grant admin authority or consume its nonce", async (t) => {
  let calls = 0;
  let nonceClaims = 0;
  const runtime = createBackendServer({
    namespace,
    gatewaySecret: secret,
    adminToken,
    redis: {
      async execute() {
        nonceClaims++;
        return "OK";
      },
    },
    ready: async () => true,
    async handle() {
      calls++;
      return Response.json({ accepted: true });
    },
  });
  t.after(() => runtime.drain());
  const target = new Request(origin(runtime.server) + "/api/admin/partner-keys", {
    headers: operator,
  });
  const response = await fetch(target.url, {
    headers: signGatewayRequest(target, secret, "198.51.100.9", namespace),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "gateway_forbidden");
  assert.equal(calls, 0);
  assert.equal(nonceClaims, 0);
});

test("gateway authentication binds the exact encoded target and claims each nonce once", async (t) => {
  const nonces = new Set<string>();
  let calls = 0;
  const quota = {
    async execute(command: string[]) {
      assert.equal(command[0], "EVALSHA", "Replay and endpoint admission use one script.");
      const key = command[3]!;
      assert.ok(key.includes(":gateway-replay:"));
      if (nonces.has(key)) {
        return [2, 0, 0];
      }
      nonces.add(key);
      return [1, 0, 0];
    },
  };
  const read = async () => {
    calls++;
    return Response.json({ accepted: true });
  };
  const api = createBackendApi({
    namespace,
    redis: quota,
    subjectPepper: "p".repeat(32),
    keys: {
      async verify() {
        assert.fail("No SQL for public gateway reads");
      },
      async allowsOrigin() {
        return false;
      },
    },
    handlers: () => ({
      market: read,
      prices: read,
      presales: read,
      featured: read,
      presale: read,
      discovery: read,
      search: read,
      defillama: read,
      daily_stats: read,
      wallet_launches: read,
      presale_proof: read,
      coin_metadata: read,
    }),
  });
  const runtime = createBackendServer({
    namespace,
    gatewaySecret: secret,
    ready: async () => true,
    redis: quota,
    async handle(request, client, gateway, context) {
      assert.equal(gateway, true);
      assert.equal(new URL(request.url).search, "?coin=a%2Fb&next=x%252Fy");
      assert.equal(request.headers.get("x-blast-gateway-signature"), null);
      return api(request, client, gateway, context);
    },
  });
  t.after(() => runtime.drain());
  const target = new Request(
    origin(runtime.server) + "/internal/public-read/api/v1/prices?coin=a%2Fb&next=x%252Fy",
  );
  const headers = signGatewayRequest(target, secret, "198.51.100.9", namespace);
  const changed = await fetch(target.url + "&changed=1", { headers });
  assert.equal(changed.status, 403);
  await changed.body?.cancel();
  const accepted = await fetch(target.url, { headers });
  assert.equal(accepted.status, 200);
  await accepted.body?.cancel();
  const replay = await fetch(target.url, { headers });
  assert.equal(replay.status, 403);
  await replay.body?.cancel();
  assert.equal(calls, 1);
  assert.equal(nonces.size, 1);
});

test("admin admission is a subset of total admission and leaves room for public reads", async (t) => {
  let complete!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const runtime = createBackendServer({
    redis,
    namespace,
    gatewaySecret: secret,
    adminToken,
    maxInflight: 3,
    maxAdminInflight: 1,
    ready: async () => true,
    handle(request) {
      if (new URL(request.url).pathname.startsWith("/api/admin/")) {
        entered();
        return new Promise((resolve) => {
          complete = resolve;
        });
      }
      return Promise.resolve(Response.json({ public: true }));
    },
  });
  t.after(() => runtime.drain());
  const base = origin(runtime.server);
  const first = fetch(base + "/api/admin/partner-keys", { headers: operator });
  await started;
  try {
    const overflow = await fetch(base + "/api/admin/partner-keys", { headers: operator });
    assert.equal(overflow.status, 503);
    assert.equal((await overflow.json()).error.code, "busy");
    const publicRead = await fetch(base + "/api/v1/prices");
    assert.equal(publicRead.status, 200);
    await publicRead.body?.cancel();
  } finally {
    complete(Response.json({ done: true }));
    await (await first).body?.cancel();
  }
});

test("streamed responses retain their permit until cancellation", async (t) => {
  let cancelled = false;
  const runtime = createBackendServer({
    redis,
    namespace,
    gatewaySecret: secret,
    maxInflight: 1,
    ready: async () => true,
    async handle(request) {
      if (new URL(request.url).search) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }
      return Response.json({ done: true });
    },
  });
  t.after(() => runtime.drain());
  const base = origin(runtime.server);
  const controller = new AbortController();
  const first = await fetch(base + "/api/v1/prices?stream=1", {
    signal: controller.signal,
  });
  const reader = first.body!.getReader();
  await reader.read();
  const busy = await fetch(base + "/api/v1/prices");
  assert.equal(busy.status, 503);
  await busy.body?.cancel();
  controller.abort();
  await reader.cancel().catch(() => {});
  for (let attempt = 0; !cancelled && attempt < 100; attempt++) {
    await pause(10);
  }
  assert.equal(cancelled, true);
  const recovered = await fetch(base + "/api/v1/prices");
  assert.equal(recovered.status, 200);
  await recovered.body?.cancel();
});

test(
  "timeouts abort work but retain permits for handlers that ignore cancellation",
  { timeout: 10_000 },
  async (t) => {
    let complete!: (response: Response) => void;
    let lateBodyCancelled = false;
    let observedSignal: AbortSignal | undefined;
    const runtime = createBackendServer({
      redis,
      namespace,
      gatewaySecret: secret,
      maxInflight: 1,
      ready: async () => true,
      handle(request) {
        if (new URL(request.url).search) {
          observedSignal = request.signal;
          return new Promise((resolve) => {
            complete = resolve;
          });
        }
        return Promise.resolve(Response.json({ done: true }));
      },
    });
    t.after(() => runtime.drain());
    const base = origin(runtime.server);
    const timedOut = await fetch(base + "/api/v1/prices?stall=1");
    assert.equal(timedOut.status, 503);
    await timedOut.body?.cancel();
    assert.equal(observedSignal?.aborted, true);
    const busy = await fetch(base + "/api/v1/prices");
    assert.equal(busy.status, 503);
    await busy.body?.cancel();
    complete(
      new Response(
        new ReadableStream({
          cancel() {
            lateBodyCancelled = true;
          },
        }),
      ),
    );
    for (let attempt = 0; !lateBodyCancelled && attempt < 100; attempt++) {
      await pause(10);
    }
    assert.equal(lateBodyCancelled, true);
    const recovered = await fetch(base + "/api/v1/prices");
    assert.equal(recovered.status, 200);
    await recovered.body?.cancel();
  },
);

test("raw HTTP framing, parsed header and chunked-body bounds refuse work before dispatch", async (t) => {
  let calls = 0;
  const runtime = createBackendServer({
    redis,
    namespace,
    gatewaySecret: secret,
    adminToken,
    ready: async () => true,
    async handle() {
      calls++;
      return Response.json({ accepted: true });
    },
  });
  t.after(() => runtime.drain());
  const port = runtime.server.port!;
  const oversizedHeader = await rawHttp(
    port,
    `GET /api/v1/prices HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nX-Large: ${"x".repeat(17_000)}\r\n\r\n`,
  );
  assert.match(oversizedHeader, /^HTTP\/1\.1 (400|431)/);
  const ambiguous = await rawHttp(
    port,
    `POST /api/admin/partner-keys HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer ${adminToken}\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\nx`,
  );
  assert.match(ambiguous, /^HTTP\/1\.1 400/);
  const chunked = await rawHttp(
    port,
    `POST /api/admin/partner-keys HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer ${adminToken}\r\nTransfer-Encoding: chunked\r\n\r\n2001\r\n${"x".repeat(8_193)}\r\n0\r\n\r\n`,
  );
  assert.match(chunked, /^HTTP\/1\.1 413/);
  assert.equal(calls, 0);
});

test("readiness is bounded and deduplicated while liveness stays independent", async (t) => {
  let readyCalls = 0;
  let complete!: (ready: boolean) => void;
  const runtime = createBackendServer({
    redis,
    namespace,
    gatewaySecret: secret,
    ready() {
      readyCalls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    },
    async handle() {
      throw new Error("Health probes cannot reach feature handlers.");
    },
  });
  t.after(() => runtime.drain());
  const base = origin(runtime.server);
  const probes = [fetch(base + "/v1/health"), fetch(base + "/v1/health")];
  for (let attempt = 0; !readyCalls && attempt < 100; attempt++) {
    await pause(10);
  }
  const live = await fetch(base + "/v1/live");
  assert.equal(live.status, 200);
  assert.equal(await live.text(), "live");
  assert.equal(readyCalls, 1);
  complete(false);
  for (const response of await Promise.all(probes)) {
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "unavailable");
  }
  const repeated = await fetch(base + "/v1/health");
  assert.equal(repeated.status, 503);
  await repeated.body?.cancel();
  assert.equal(readyCalls, 1);
});

test("native drain closes admission and lets an existing response finish", async () => {
  let finish!: () => void;
  const runtime = createBackendServer({
    redis,
    namespace,
    gatewaySecret: secret,
    ready: async () => true,
    async handle() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("first"));
            let ended = false;
            finish = () => {
              if (ended) {
                return;
              }
              ended = true;
              controller.enqueue(new TextEncoder().encode("last"));
              controller.close();
            };
          },
        }),
      );
    },
  });
  try {
    const base = origin(runtime.server);
    const response = await fetch(base + "/api/v1/prices");
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
    let stopped = false;
    const draining = runtime.drain().then(() => {
      stopped = true;
    });
    await pause(20);
    assert.equal(stopped, false, "An active response is allowed to finish.");
    await assert.rejects(fetch(base + "/api/v1/prices", { keepalive: false }));
    finish();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
    assert.equal((await reader.read()).done, true);
    await draining;
  } finally {
    finish?.();
    await runtime.drain();
  }
});

test(
  "an incomplete admin body is aborted at the transport deadline before dispatch",
  { timeout: 10_000 },
  async (t) => {
    let calls = 0;
    const runtime = createBackendServer({
      redis,
      namespace,
      gatewaySecret: secret,
      adminToken,
      ready: async () => true,
      async handle() {
        calls++;
        return Response.json({ accepted: true });
      },
    });
    t.after(() => runtime.drain());
    const started = performance.now();
    const response = await rawHttp(
      runtime.server.port!,
      `POST /api/admin/partner-keys HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nAuthorization: Bearer ${adminToken}\r\nContent-Length: 8192\r\n\r\nx`,
    );
    assert.match(response, /^HTTP\/1\.1 503/);
    assert.ok(
      performance.now() - started < 5_000,
      "The application deadline precedes the native idle timeout.",
    );
    assert.equal(calls, 0);
    const recovered = await fetch(origin(runtime.server) + "/api/v1/prices");
    assert.equal(recovered.status, 200);
    await recovered.body?.cancel();
  },
);

test(
  "drain waits for an admitted admin operation after its response deadline",
  { timeout: 10_000 },
  async () => {
    let complete!: (response: Response) => void;
    const runtime = createBackendServer({
      redis,
      namespace,
      gatewaySecret: secret,
      adminToken,
      ready: async () => true,
      handle() {
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    let draining: Promise<void> | undefined;
    try {
      const response = await fetch(origin(runtime.server) + "/api/admin/partner-keys", {
        method: "POST",
        headers: operator,
        body: "{}",
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "service_unavailable");
      let stopped = false;
      draining = runtime.drain().then(() => {
        stopped = true;
      });
      await pause(30);
      assert.equal(
        stopped,
        false,
        "Returning a deadline response must not end an admitted mutation's drain lifetime.",
      );
    } finally {
      complete?.(Response.json({ completed: true }));
      await (draining ?? runtime.drain());
    }
  },
);
