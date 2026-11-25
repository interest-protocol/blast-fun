import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { PRIVATE_ROUTES, privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createBackendHttp, type BackendHttpOptions } from "../src/app/server.ts";
import { deferred } from "../../../packages/core/test/kit.ts";

const siteOrigin = "https://frontend.test";
const environment = {
  NEXT_PUBLIC_SITE_URL: siteOrigin,
  BLAST_BACKEND_API_ORIGIN: "https://backend.test",
  BLAST_REDIS_NAMESPACE: "local-resource-admission",
  BLAST_BACKEND_GATEWAY_SECRET: "synthetic-private-resource-secret-0123456789",
};

function fixture(overrides: Partial<BackendHttpOptions> = {}) {
  const backend = createBackendHttp({
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
    redis: {
      async execute() {
        return "OK";
      },
    },
    ready: async () => true,
    handle: async () => {
      throw new Error("Private dispatch required");
    },
    ...overrides,
  });
  const relay = privateBackendRelay(parseRelayConfig(environment), {
    clientAddress: () => "192.0.2.1",
    fetch: (input, init) => backend.fetch(new Request(input, init), "127.0.0.1"),
  });
  return { backend, relay };
}

async function consumed(response: Response) {
  await response.arrayBuffer();
  return response.status;
}

test("coalesced readiness has bounded reserved capacity and retains dependency/draining failures", async () => {
  const owner = deferred();
  const entered = deferred();
  const probe = deferred();
  let calls = 0;
  const { backend, relay } = fixture({
    maxInflight: 1,
    ready: async () => {
      calls++;
      await probe.promise;
      return true;
    },
    privateApi: {
      siteOrigin,
      async handle() {
        entered.resolve();
        await owner.promise;
        return new Response("owned");
      },
    },
  });
  const pending = relay(new Request(siteOrigin + "/api/social/me"));
  await entered.promise;
  const probes = Array.from({ length: 8 }, () =>
    backend.fetch(new Request("https://backend.test/v1/health"), "127.0.0.1", 100),
  );
  await pause(0);
  assert.equal(calls, 1, "all admitted probes share one dependency operation");
  assert.equal(
    await consumed(await backend.fetch(new Request("https://backend.test/v1/health"), "127.0.0.1")),
    503,
    "probe response admission is bounded independently",
  );
  probe.resolve();
  assert.deepEqual(
    await Promise.all(probes.map(async (result) => consumed(await result))),
    Array(8).fill(200),
    "ordinary saturation cannot fail passing readiness",
  );
  const drained = backend.drain();
  assert.equal(
    await consumed(await backend.fetch(new Request("https://backend.test/v1/health"), "127.0.0.1")),
    503,
    "a cached pass cannot override draining",
  );
  owner.resolve();
  assert.equal(await consumed(await pending), 200);
  await drained;
  const failed = fixture({
    ready: async () => {
      throw new Error("dependency unavailable");
    },
  }).backend;
  assert.equal(
    await consumed(await failed.fetch(new Request("https://backend.test/v1/health"), "127.0.0.1")),
    503,
  );
  await failed.drain();
});

for (const [name, maximum, path, method] of [
  ["render", 2, "/presale/synthetic/share-image", "GET"],
  ["quote", 4, "/api/social/trades/quote", "POST"],
  ["trade", 4, "/api/social/trades", "POST"],
  ["long-work", 4, "/api/social/me/wallet", "GET"],
] as const) {
  test(`${name} capacity remains owned until actual work settles`, async () => {
    const work = deferred();
    let owners = 0;
    const { backend, relay } = fixture({
      privateApi: {
        siteOrigin,
        async handle(request) {
          if (new URL(request.url).pathname !== "/api/social/me") {
            owners++;
            trackRequestWork(work.promise);
          }
          return new Response("accepted");
        },
      },
    });
    const expensive = () => relay(new Request(siteOrigin + path, { method }));
    try {
      for (let i = 0; i < maximum; i++) {
        assert.equal(await consumed(await expensive()), 200);
      }
      assert.equal(
        await consumed(await expensive()),
        503,
        "finishing the visible response does not free provider/render work",
      );
      assert.equal(owners, maximum, "refused work never enters the owner");
      assert.equal(
        await consumed(await relay(new Request(siteOrigin + "/api/social/me"))),
        200,
        "ordinary private reads retain capacity",
      );
      work.resolve();
      await pause(0);
      assert.equal(
        await consumed(await expensive()),
        200,
        "completed actual work releases its resource permit",
      );
    } finally {
      work.resolve();
      await backend.drain();
    }
  });
}

test("private replay uses its own Redis connection while retaining the exact nonce identity", async () => {
  const keys: string[] = [];
  let nonce: string | undefined;
  const { backend, relay } = fixture({
    redis: {
      async execute() {
        assert.fail("Private replay cannot use the quota connection");
      },
    },
    privateReplayRedis: {
      async execute(args) {
        keys.push(args[1]!);
        return "OK";
      },
    },
    privateApi: {
      siteOrigin,
      async handle(_request, { proof }) {
        nonce = proof.nonce;
        return new Response("ok");
      },
    },
  });
  assert.equal(await consumed(await relay(new Request(siteOrigin + "/api/social/me"))), 200);
  assert.equal(keys.length, 1);
  assert.equal(
    keys[0],
    `${quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment))}:{partner-quota}:private-replay:${nonce}`,
  );
  await backend.drain();
});

function slowBody(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      await pause(1_100);
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
}

test("large bounded uploads survive a one-second body transfer at both private boundaries", async () => {
  const payload = new Uint8Array(100_000).fill(17);
  const backend = fixture({
    privateApi: {
      siteOrigin,
      async handle(request) {
        assert.deepEqual(new Uint8Array(await request.arrayBuffer()), payload);
        return new Response("uploaded");
      },
    },
  }).backend;
  const relay = privateBackendRelay(parseRelayConfig(environment), {
    clientAddress: () => "192.0.2.1",
    async fetch(input, init) {
      const forwarded = new Request(input, {
        ...init,
        body: slowBody(payload),
        duplex: "half",
      } as RequestInit);
      return backend.fetch(forwarded, "127.0.0.1");
    },
  });
  try {
    const response = await relay(
      new Request(siteOrigin + "/api/social/me/drafts/synthetic/cover", {
        method: "POST",
        body: slowBody(payload),
        duplex: "half",
      } as RequestInit),
    );
    assert.equal(await consumed(response), 200);
  } finally {
    await backend.drain();
  }
});

test("mixed expensive classes cannot exhaust ordinary admission or readiness", async () => {
  const work = deferred();
  let owners = 0;
  const { backend, relay } = fixture({
    privateApi: {
      siteOrigin,
      async handle(request) {
        if (new URL(request.url).pathname !== "/api/social/me") {
          owners++;
          trackRequestWork(work.promise);
        }
        return new Response("ok");
      },
    },
  });
  try {
    for (const [count, path, method] of [
      [2, "/presale/synthetic/share-image", "GET"],
      [2, "/api/social/trades/quote", "POST"],
      [2, "/api/social/trades", "POST"],
      [2, "/api/social/me/profile/picture", "PUT"],
    ] as const) {
      for (let i = 0; i < count; i++) {
        assert.equal(await consumed(await relay(new Request(siteOrigin + path, { method }))), 200);
      }
    }
    assert.equal(owners, 8);
    assert.equal(
      await consumed(
        await relay(
          new Request(siteOrigin + "/api/presale/allowlists", {
            method: "POST",
          }),
        ),
      ),
      503,
      "the shared expensive cap bounds mixed resource classes",
    );
    assert.equal(owners, 8, "mixed overload never enters another expensive owner");
    assert.equal(await consumed(await relay(new Request(siteOrigin + "/api/social/me"))), 200);
    assert.equal(
      await consumed(
        await backend.fetch(new Request("https://backend.test/v1/health"), "127.0.0.1"),
      ),
      200,
    );
  } finally {
    work.resolve();
    await backend.drain();
  }
});

test("resource classes are explicit and independent of wall-clock budgets", () => {
  for (const route of PRIVATE_ROUTES) {
    if ((route.workBudgetMs ?? 30_000) > 30_000) {
      assert.ok(route.resourceClass, `${route.id} requires a reviewed resource class`);
    }
  }
  assert.equal(privateRoute("GET", "/api/social/me/profile", "browser")?.resourceClass, "ordinary");
  assert.equal(privateRoute("GET", "/api/social/me/profile", "browser")?.workBudgetMs, 60_000);
  assert.equal(
    privateRoute("GET", "/api/social/me/wallet", "browser")?.resourceClass,
    "provider-heavy",
  );
  assert.equal(
    privateRoute("POST", "/api/social/trades/quote", "browser")?.resourceClass,
    "provider-heavy",
  );
  assert.equal(
    privateRoute("GET", "/api/presale/receipts/sale/wallet/image", "browser")?.resourceClass,
    "bulk",
  );
});

test("provider and bulk work share four permits while audited ordinary long reads remain admitted", async () => {
  const { backend, relay } = fixture({
    privateApi: {
      siteOrigin,
      async handle(request) {
        if (new URL(request.url).pathname === "/api/social/me/profile") {
          return new Response("ordinary");
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
          }),
        );
      },
    },
  });
  const held: Response[] = [];
  const request = (path: string, method: string) =>
    relay(new Request(siteOrigin + path, { method }));
  try {
    // Trading has its own reserved lanes; slow provider reads share with bulk work.
    for (let i = 0; i < 2; i++) {
      held.push(await request("/api/social/me/wallet", "GET"));
      held.push(await request("/api/social/me/drafts/draft", "PUT"));
    }
    assert.deepEqual(
      held.map((response) => response.status),
      [200, 200, 200, 200],
    );
    assert.equal(
      await consumed(await request("/api/social/me/wallet", "GET")),
      503,
      "provider work cannot borrow additional bulk permits",
    );
    assert.equal(
      await consumed(await request("/api/social/me/drafts/draft", "PUT")),
      503,
      "bulk work shares the same existing four-work limit",
    );
    assert.equal(
      await consumed(await request("/api/social/me/profile", "GET")),
      200,
      "a reviewed DB-only read is not classified by its sixty-second budget",
    );
  } finally {
    for (const response of held) {
      await response.body!.cancel();
    }
    await backend.drain();
  }
});

test(
  "a capped long private read aborts its owner and releases drain at the effective deadline",
  { timeout: 2000 },
  async () => {
    const owner = deferred();
    const entered = deferred();
    let signal: AbortSignal | undefined;
    const { backend, relay } = fixture({
      maxPrivateWorkMs: 25,
      privateApi: {
        siteOrigin,
        async handle(request) {
          signal = request.signal;
          request.signal.addEventListener("abort", owner.resolve, {
            once: true,
          });
          entered.resolve();
          await owner.promise;
          return new Response("completed");
        },
      },
    });
    assert.equal(
      privateRoute("GET", "/api/social/me/creator-earnings", "browser")?.workBudgetMs,
      300_000,
    );
    const pending = relay(new Request(siteOrigin + "/api/social/me/creator-earnings"));
    try {
      await entered.promise;
      const drained = backend.drain();
      const result = await Promise.race([
        pending.then(consumed),
        pause(250).then(() => "deadline missed"),
      ]);
      assert.equal(result, 503);
      assert.equal(signal?.aborted, true);
      await drained;
    } finally {
      owner.resolve();
      await (await pending).body?.cancel().catch(() => {});
      await backend.drain();
    }
  },
);
