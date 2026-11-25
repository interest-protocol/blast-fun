import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import type { PrivateHandler } from "@blast/server/private/handler.ts";
import { createPrivateHttp } from "../src/app/api/private-http.ts";
import { createBackendServer } from "../src/app/server.ts";
import { PRIVATE_ROUTES, privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";

const siteOrigin = "https://frontend.test";
const environment = {
  NEXT_PUBLIC_SITE_URL: siteOrigin + "/",
  BLAST_REDIS_NAMESPACE: "local-native-private",
  BLAST_BACKEND_GATEWAY_SECRET: "synthetic-private-native-secret-0123456789",
};

test("every private API contract reaches its capability through native Effect dispatch", async () => {
  let dispatched = 0;
  let canceled = 0;
  const owners = Object.fromEntries(
    PRIVATE_ROUTES.map(({ id }) => {
      const operation: PrivateHandler = async (request, { proof }) => {
        dispatched++;
        assert.equal(proof.route.id, id);
        assert.equal(proof.route.method, request.method);
        assert.equal(request.headers.has("x-blast-private-signature"), false);
        const bytes = Buffer.from(await request.arrayBuffer()).toString("hex");
        const headers = new Headers({ "X-Owner": id, "Content-Type": "application/octet-stream" });
        headers.append("Set-Cookie", "fixture=first");
        headers.append("Set-Cookie", "fixture=second");
        const url = new URL(request.url);
        if (url.search === "?fixture=redirect") {
          headers.set("Location", "/sign-in");
          return new Response(null, { status: 303, headers });
        }
        if (request.method === "HEAD") {
          return new Response(
            new ReadableStream({
              cancel() {
                canceled++;
              },
            }),
            { headers },
          );
        }
        return new Response(`${url.pathname}${url.search}|${proof.purpose}|${bytes}`, {
          headers,
        });
      };
      return [id, operation] as const;
    }),
  );
  const api = createPrivateHttp(owners);
  const native = createBackendServer({
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
    redis: { execute: async () => "OK" },
    ready: async () => true,
    handle: async () => assert.fail("Public admission cannot handle a private capability."),
    privateApi: { siteOrigin, handle: api.handle },
  });
  const relay = privateBackendRelay(
    parseRelayConfig({
      ...environment,
      BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${native.server.port}`,
    }),
    { clientAddress: () => "192.0.2.1" },
  );
  try {
    for (const route of PRIVATE_ROUTES) {
      const segment = route.id === "social.launch.read" ? "DISCOVERY" : "fixture;%ff";
      const path = route.path.replace(/:\w+/g, segment);
      const purpose = route.ssrOnly ? "ssr-read" : "browser";
      const bytes = route.maxBodyBytes > 0 && !["GET", "HEAD"].includes(route.method);
      const answer = await relay(
        new Request(siteOrigin + path + "?tag=%ff&tag=a+b", {
          method: route.method,
          ...(bytes ? { body: new Uint8Array([0x00, 0xff, 0x41]) } : {}),
        }),
        purpose,
      );
      assert.equal(answer.status, 200, `${route.method} ${path}`);
      assert.equal(answer.headers.get("x-owner"), route.id, path);
      assert.deepEqual(answer.headers.getSetCookie(), ["fixture=first", "fixture=second"], path);
      assert.equal(
        await answer.text(),
        route.method === "HEAD"
          ? ""
          : `${path}?tag=%ff&tag=a+b|${purpose}|${bytes ? "00ff41" : ""}`,
        path,
      );
    }
    const redirect = await relay(new Request(siteOrigin + "/api/gate?fixture=redirect"));
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get("location"), "/sign-in");
    assert.deepEqual(redirect.headers.getSetCookie(), ["fixture=first", "fixture=second"]);
  } finally {
    await native.drain();
    await api.dispose();
  }
  assert.equal(dispatched, PRIVATE_ROUTES.length + 1);
  assert.equal(canceled, PRIVATE_ROUTES.filter(({ method }) => method === "HEAD").length);
});

test("native private transport forwards intentional redirects and cookies without following signed requests", async () => {
  let calls = 0;
  const runtime = createBackendServer({
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
    redis: {
      async execute() {
        return "OK";
      },
    },
    ready: async () => true,
    handle: async () => {
      assert.fail("Public admission cannot own browser bootstrap");
    },
    privateApi: {
      siteOrigin,
      async handle(request) {
        calls++;
        assert.equal(request.method, "GET");
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/sign-in",
            "Set-Cookie": "fixture_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
          },
        });
      },
    },
  });
  const relay = privateBackendRelay(
    parseRelayConfig({
      ...environment,
      BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}`,
    }),
    { clientAddress: () => "192.0.2.1" },
  );
  try {
    const answer = await relay(new Request(siteOrigin + "/api/gate"));
    assert.equal(answer.status, 303);
    assert.equal(answer.headers.get("location"), "/sign-in");
    assert.equal(answer.headers.getSetCookie().length, 1);
    assert.match(answer.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal(calls, 1, "redirect must not replay the proof");
  } finally {
    await runtime.drain();
  }
});

test("manual private forwarding never sends signed headers to an owner-produced redirect target", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const relay = privateBackendRelay(
      parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: "http://127.0.0.1:12345" }),
      {
        clientAddress: () => "192.0.2.1",
        async fetch(input, init) {
          calls++;
          assert.equal(String(input), "http://127.0.0.1:12345/api/gate");
          assert.equal(init?.redirect, "manual");
          return new Response(null, {
            status,
            headers: { Location: "https://external.example.test/owner-controlled" },
          });
        },
      },
    );
    const answer = await relay(new Request(siteOrigin + "/api/gate"));
    assert.equal(answer.status, status);
    assert.equal(answer.headers.get("location"), "https://external.example.test/owner-controlled");
    assert.equal(calls, 1);
  }
});

test(
  "native private transport survives the old five-second idle limit and preserves HEAD and separate cookies",
  { timeout: 15_000 },
  async () => {
    let reads = 0;
    const runtime = createBackendServer({
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
      gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
      redis: {
        async execute() {
          return "OK";
        },
      },
      ready: async () => true,
      handle: async () => {
        assert.fail("Public admission cannot handle private requests");
      },
      privateApi: {
        siteOrigin,
        async handle(request) {
          if (request.method === "GET") {
            reads++;
            await pause(5_500);
          }
          const headers = new Headers({ "Content-Type": "application/json" });
          headers.append(
            "Set-Cookie",
            "__Host-blast_wallet=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
          );
          headers.append(
            "Set-Cookie",
            "__Host-blast_wallet_hint=; Path=/; Max-Age=0; Secure; SameSite=Strict",
          );
          return Response.json({ bytes: (await request.arrayBuffer()).byteLength }, { headers });
        },
      },
    });
    const relay = privateBackendRelay(
      parseRelayConfig({
        ...environment,
        BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}`,
      }),
      { clientAddress: () => "192.0.2.1" },
    );
    try {
      const answer = await relay(
        new Request(siteOrigin + "/api/social/me", {
          headers: { origin: siteOrigin, "sec-fetch-site": "same-origin" },
        }),
      );
      assert.equal(answer.status, 200);
      assert.equal(reads, 1);
      assert.equal(answer.headers.getSetCookie().length, 2);
      const head = await relay(new Request(siteOrigin + "/api/social/me", { method: "HEAD" }));
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal(head.headers.getSetCookie().length, 2);
      const exact = await relay(
        new Request(siteOrigin + "/api/social/sign-in/session", {
          method: "POST",
          body: new Uint8Array(12_288),
        }),
      );
      assert.equal(exact.status, 200);
      assert.deepEqual(await exact.json(), { bytes: 12_288 });
      const large = await relay(
        new Request(siteOrigin + "/api/social/sign-in/session", {
          method: "POST",
          body: new Uint8Array(12_289),
        }),
      );
      assert.equal(large.status, 413);
    } finally {
      await runtime.drain();
    }
  },
);

test("native authenticated socket allowances and shutdown follow the selected private work cap", async () => {
  for (const [maximum, expectedDrain, expectedSocket] of [
    [undefined, 310_000, 0],
    [280_000, 290_000, 0],
    [180_000, 190_000, 190],
  ] as const) {
    const allowances: number[] = [];
    const runtime = createBackendServer({
      maxPrivateWorkMs: maximum,
      namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
      gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
      redis: {
        async execute() {
          return "OK";
        },
      },
      ready: async () => true,
      handle: async () => {
        assert.fail("Private routing required");
      },
      privateApi: {
        siteOrigin,
        async handle() {
          return Response.json({ synthetic: true });
        },
      },
    });
    const nativeTimeout = runtime.server.timeout.bind(runtime.server);
    runtime.server.timeout = (request, seconds) => {
      allowances.push(seconds);
      nativeTimeout(request, seconds);
    };
    const relay = privateBackendRelay(
      parseRelayConfig({
        ...environment,
        BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${runtime.server.port}`,
      }),
      { clientAddress: () => "192.0.2.1" },
    );
    try {
      assert.equal(runtime.drainTimeoutMs, expectedDrain);
      const long = await relay(new Request(siteOrigin + "/api/social/me/creator-earnings"));
      assert.equal(long.status, 200);
      await long.arrayBuffer();
      assert.deepEqual(allowances, [40, expectedSocket]);
      allowances.length = 0;
      // This synthetic owner never executes a financial operation.
      assert.equal(
        privateRoute("POST", "/api/presale/sponsor/fixture/execute", "browser")?.workBudgetMs,
        90_000,
      );
      const financial = await relay(
        new Request(siteOrigin + "/api/presale/sponsor/fixture/execute", {
          method: "POST",
        }),
      );
      assert.equal(financial.status, 200);
      await financial.arrayBuffer();
      assert.deepEqual(
        allowances,
        [40, 100],
        "the existing 90-second financial budget is unchanged",
      );
    } finally {
      await runtime.drain();
    }
  }
});
