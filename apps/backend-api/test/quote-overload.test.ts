import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { SOCIAL_ERROR_MESSAGES } from "@blast/core/modules/social/contracts/errors.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createBackendHttp } from "../src/app/server.ts";
import { relayToOneBackend } from "./relay-fixture.ts";
import { deferred } from "../../../packages/core/test/kit.ts";

const siteOrigin = "https://frontend.test";
const backendOrigin = "https://backend.test";
const quotePath = "/api/social/trades/quote";
const environment = {
  NEXT_PUBLIC_SITE_URL: siteOrigin,
  BLAST_BACKEND_API_ORIGIN: backendOrigin,
  BLAST_REDIS_NAMESPACE: "local-quote-overload",
  BLAST_BACKEND_GATEWAY_SECRET: "synthetic-quote-overload-secret-0123456789",
};

function fixture(maxInflight = 64) {
  const work = deferred();
  const nonces = new Set<string>();
  const owners: string[] = [];
  let replayWrites = 0;
  const backend = createBackendHttp({
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
    maxInflight,
    ready: async () => true,
    redis: {
      async execute(args) {
        replayWrites++;
        if (nonces.has(args[1]!)) {
          return null;
        }
        nonces.add(args[1]!);
        return "OK";
      },
    },
    handle: async () => {
      throw new Error("Private dispatch required");
    },
    privateApi: {
      siteOrigin,
      async handle(request) {
        const path = new URL(request.url).pathname;
        owners.push(path);
        if (path !== "/api/social/me" && path !== "/api/social/activity/hints") {
          trackRequestWork(work.promise);
        }
        return new Response("accepted");
      },
    },
  });
  const relay = relayToOneBackend(environment, {
    clientAddress: () => "192.0.2.1",
    fetch: (input, init) => backend.fetch(new Request(input, init), "127.0.0.1"),
  });
  const request = (path = quotePath, method = "POST") =>
    relay(new Request(siteOrigin + path, { method }));
  return { backend, request, work, owners, replayWrites: () => replayWrites };
}

async function consumed(response: Response): Promise<number> {
  await response.arrayBuffer();
  return response.status;
}

async function quoteBusy(response: Response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(response.headers.get("X-Request-ID"));
  assert.deepEqual(await response.json(), {
    error: { code: "quote_busy", message: SOCIAL_ERROR_MESSAGES.quote_busy },
  });
}

async function genericBusy(response: Response) {
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.deepEqual(await response.json(), { error: { code: "busy" } });
}

function signed(body = "{}", declaredBody = body, mutate?: (headers: Headers) => void) {
  const bytes = new TextEncoder().encode(declaredBody);
  const source = new Request(siteOrigin + quotePath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: bytes,
  });
  const headers = signPrivateRequest(source, bytes, environment.BLAST_BACKEND_GATEWAY_SECRET, {
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    purpose: "browser",
    siteOrigin,
    ip: "192.0.2.1",
  });
  mutate?.(headers);
  return new Request(backendOrigin + quotePath, { method: "POST", headers, body });
}

test("authenticated quote lane saturation has a safe quote_busy refusal and retains all four permits until actual work settles", async () => {
  const source = fixture();
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal(await consumed(await source.request()), 200);
    }
    await quoteBusy(await source.request());
    assert.equal(
      source.owners.length,
      4,
      "excess quotes do not enter owner rates, database or provider work",
    );
    assert.equal(
      source.replayWrites(),
      4,
      "resource refusal happens at the existing authenticated pre-body/nonce seam",
    );
    assert.equal(
      await consumed(await source.request("/api/social/me/wallet", "GET")),
      200,
      "slow provider reads have their own lane",
    );
    assert.equal(source.owners.length, 5);
    assert.equal(await consumed(await source.request("/api/social/me", "GET")), 200);
    source.work.resolve();
    await pause(0);
    assert.equal(
      await consumed(await source.request()),
      200,
      "actual completion releases capacity",
    );
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("other expensive work cannot take trading's reserved permits: quotes and trades still run within the eight-work and independent read budgets", async () => {
  const source = fixture();
  try {
    for (const [count, path, method] of [
      [2, "/presale/synthetic/share-image", "GET"],
      [2, "/api/social/me/profile/picture", "PUT"],
    ] as const) {
      for (let i = 0; i < count; i++) {
        assert.equal(await consumed(await source.request(path, method)), 200);
      }
    }
    assert.equal(source.owners.length, 4);
    await genericBusy(await source.request("/api/presale/allowlists", "POST"));
    await genericBusy(await source.request("/api/social/me/wallet", "GET"));
    assert.equal(
      source.owners.length,
      4,
      "aggregate refusal precedes owner work even with free lane permits",
    );
    for (let i = 0; i < 2; i++) {
      assert.equal(
        await consumed(await source.request()),
        200,
        "quotes keep their reserved permits",
      );
    }
    for (let i = 0; i < 2; i++) {
      assert.equal(
        await consumed(await source.request("/api/social/trades", "POST")),
        200,
        "trades keep theirs",
      );
    }
    assert.equal(source.owners.length, 8);
    await quoteBusy(await source.request());
    await genericBusy(await source.request("/api/social/trades", "POST"));
    assert.equal(source.owners.length, 8, "the eight-work bound is unchanged");
    assert.equal(source.replayWrites(), 8, "refusals precede the nonce burn");
    assert.equal(await consumed(await source.request("/api/social/me", "GET")), 200);
    assert.equal(await consumed(await source.request("/api/social/activity/hints", "GET")), 200);
    assert.equal(
      await consumed(
        await source.backend.fetch(new Request(backendOrigin + "/v1/health"), "127.0.0.1"),
      ),
      200,
    );
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("unsigned and counterfeit quote envelopes cannot reach authenticated quote_busy admission", async () => {
  const source = fixture();
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal(await consumed(await source.request()), 200);
    }
    for (const request of [
      new Request(backendOrigin + quotePath, { method: "POST" }),
      signed("{}", "{}", (headers) => headers.set("x-blast-private-signature", "a".repeat(43))),
    ]) {
      const response = await source.backend.fetch(request, "127.0.0.1");
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: { code: "private_gateway_forbidden" } });
    }
    assert.equal(source.owners.length, 4);
    assert.equal(source.replayWrites(), 4);
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("authenticated quote admission preserves body proof and replay enforcement before any owner work", async () => {
  const source = fixture();
  try {
    const wrongBody = await source.backend.fetch(signed('{"altered":true}', "{}"), "127.0.0.1");
    assert.equal(wrongBody.status, 403);
    assert.deepEqual(await wrongBody.json(), { error: { code: "private_gateway_forbidden" } });
    assert.equal(source.replayWrites(), 0);
    assert.equal(source.owners.length, 0);
    const original = signed();
    const replay = original.clone();
    assert.equal(await consumed(await source.backend.fetch(original, "127.0.0.1")), 200);
    const rejected = await source.backend.fetch(replay, "127.0.0.1");
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: { code: "private_gateway_replayed" } });
    assert.equal(source.owners.length, 1);
    assert.equal(source.replayWrites(), 2);
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("ordinary saturation and draining retain generic busy with its existing one-second minimum", async () => {
  const source = fixture(1);
  let drained: Promise<void> | undefined;
  try {
    assert.equal(await consumed(await source.request()), 200);
    await genericBusy(await source.request());
    assert.equal(
      source.replayWrites(),
      1,
      "ordinary refusal still precedes private proof admission",
    );
    drained = source.backend.drain();
    await genericBusy(await source.request());
    assert.equal(source.owners.length, 1);
  } finally {
    source.work.resolve();
    await (drained ?? source.backend.drain());
  }
});

test("small replicas reserve less for trading, one permit per lane in turn, and always keep two permits for other expensive work", async () => {
  // maxInflight 4: an aggregate of two, nothing reserved (the minimal two-upload contract).
  const minimal = fixture(4);
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(
        await consumed(await minimal.request("/api/social/me/profile/picture", "PUT")),
        200,
      );
    }
    await quoteBusy(await minimal.request());
  } finally {
    minimal.work.resolve();
    await minimal.backend.drain();
  }
  // maxInflight 8: an aggregate of four, one permit reserved for quotes and one for trades.
  const small = fixture(8);
  try {
    for (let i = 0; i < 2; i++) {
      assert.equal(
        await consumed(await small.request("/api/social/me/profile/picture", "PUT")),
        200,
      );
    }
    await genericBusy(await small.request("/presale/synthetic/share-image", "GET"));
    assert.equal(await consumed(await small.request()), 200, "a quote keeps its reserved permit");
    assert.equal(
      await consumed(await small.request("/api/social/trades", "POST")),
      200,
      "so does a trade",
    );
    await quoteBusy(await small.request());
    await genericBusy(await small.request("/api/social/trades", "POST"));
    assert.equal(small.owners.length, 4);
  } finally {
    small.work.resolve();
    await small.backend.drain();
  }
});
