import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
import { trackRequestWork } from "@blast/server/lib/request-work.ts";
import { createBackendHttp, type BackendHttpOptions } from "../src/app/server.ts";
import { relayToOneBackend } from "./relay-fixture.ts";
import { deferred } from "../../../packages/core/test/kit.ts";

const siteOrigin = "https://frontend.test";
const backendOrigin = "https://backend.test";
const environment = {
  NEXT_PUBLIC_SITE_URL: siteOrigin,
  BLAST_BACKEND_API_ORIGIN: backendOrigin,
  BLAST_REDIS_NAMESPACE: "local-admission-metrics",
  BLAST_BACKEND_GATEWAY_SECRET: "synthetic-admission-metric-secret-0123456789",
};
type Metric = {
  metric: string;
  at: string;
  level: number;
  lane: string;
  outcome: string;
  work?: string;
  cause?: string;
  sampleRate?: number;
};

function capture(t: TestContext, random = 0) {
  const info = console.info;
  const sampler = Math.random;
  const enabled = process.env.MISSION_CONTROL_METRICS;
  const metrics: Metric[] = [];
  console.info = (value: unknown) => {
    const metric = JSON.parse(String(value)) as Metric;
    if (metric.metric === "backend.admission") {
      metrics.push(metric);
    }
  };
  Math.random = () => random;
  process.env.MISSION_CONTROL_METRICS = "on";
  t.after(() => {
    console.info = info;
    Math.random = sampler;
    if (enabled === undefined) {
      delete process.env.MISSION_CONTROL_METRICS;
    } else {
      process.env.MISSION_CONTROL_METRICS = enabled;
    }
  });
  return metrics;
}

function fixture(overrides: Partial<BackendHttpOptions> = {}) {
  const work = deferred();
  const owners: string[] = [];
  let nonces = 0;
  const backend = createBackendHttp({
    namespace: quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    gatewaySecret: environment.BLAST_BACKEND_GATEWAY_SECRET,
    redis: {
      async execute() {
        nonces++;
        return "OK";
      },
    },
    ready: async () => true,
    handle: async () => new Response("public"),
    privateApi: {
      siteOrigin,
      async handle(request) {
        const path = new URL(request.url).pathname;
        owners.push(path);
        if (path !== "/api/social/me") {
          trackRequestWork(work.promise);
        }
        return new Response("accepted");
      },
    },
    ...overrides,
  });
  const relay = relayToOneBackend(environment, {
    clientAddress: () => "192.0.2.1",
    fetch: (input, init) => backend.fetch(new Request(input, init), "127.0.0.1"),
  });
  const request = (path = "/api/social/trades/quote", method = "POST") =>
    relay(new Request(siteOrigin + path, { method }));
  const health = () => backend.fetch(new Request(backendOrigin + "/v1/health"), "127.0.0.1");
  return { backend, request, health, work, owners, nonces: () => nonces };
}

async function consumed(response: Response) {
  await response.arrayBuffer();
  return response.status;
}

function labels(metrics: Metric[]) {
  return metrics.map(({ lane, outcome, work, cause, sampleRate }) => ({
    lane,
    outcome,
    ...(work ? { work } : {}),
    ...(cause ? { cause } : {}),
    ...(sampleRate === undefined ? {} : { sampleRate }),
  }));
}

function assertFixedFields(metrics: Metric[]) {
  const keys = ["metric", "at", "level", "lane", "outcome", "work", "cause", "sampleRate"];
  for (const metric of metrics) {
    assert.ok(Object.keys(metric).every((key) => keys.includes(key)));
    assert.ok(
      [
        "ordinary",
        "readiness",
        "quote",
        "trade",
        "long-work",
        "upload",
        "render",
        "allowlist",
        "hint",
      ].includes(metric.lane),
    );
    assert.ok(["admitted", "busy"].includes(metric.outcome));
    if (metric.work !== undefined) {
      assert.ok(["quote", "other"].includes(metric.work));
    }
    if (metric.cause !== undefined) {
      assert.ok(["capacity", "draining", "lane", "aggregate"].includes(metric.cause));
    }
    assert.match(metric.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(metric.level, 30, "Pino info");
    if (metric.outcome === "admitted") {
      assert.equal(metric.sampleRate, 0.02);
    } else {
      assert.equal(metric.sampleRate, undefined, "all capacity refusals are retained");
    }
  }
  assert.doesNotMatch(
    JSON.stringify(metrics),
    /frontend|backend\.test|192\.0\.2|private-signature|synthetic|trades\/quote|quote_busy|provider|nonce/i,
  );
}

test("ordinary observations report actual preauthentication admission without trusting a spoofed private quote path", async (t) => {
  const metrics = capture(t);
  const source = fixture();
  try {
    const unsigned = await source.backend.fetch(
      new Request(backendOrigin + "/api/social/trades/quote", { method: "POST" }),
      "127.0.0.1",
    );
    assert.equal(await consumed(unsigned), 403);
    assert.deepEqual(metrics, [], "classification refusal holds no permit");
    const path = "/api/social/trades/quote";
    const headers = signPrivateRequest(
      new Request(siteOrigin + path, { method: "POST" }),
      new Uint8Array(),
      environment.BLAST_BACKEND_GATEWAY_SECRET,
      {
        namespace: quotaNamespace(
          environment.BLAST_REDIS_NAMESPACE,
          deploymentIdentity(environment),
        ),
        purpose: "browser",
        siteOrigin,
        ip: "192.0.2.1",
      },
    );
    headers.set("x-blast-private-signature", "a".repeat(43));
    assert.equal(
      await consumed(
        await source.backend.fetch(
          new Request(backendOrigin + path, { method: "POST", headers }),
          "127.0.0.1",
        ),
      ),
      403,
    );
    assert.deepEqual(labels(metrics), [
      { lane: "ordinary", outcome: "admitted", sampleRate: 0.02 },
    ]);
    assert.equal(source.owners.length, 0);
    assert.equal(source.nonces(), 0);
    assert.equal(await consumed(await source.request()), 200);
    assert.deepEqual(labels(metrics).slice(1), [
      { lane: "ordinary", outcome: "admitted", sampleRate: 0.02 },
      { lane: "quote", outcome: "admitted", work: "quote", sampleRate: 0.02 },
    ]);
    assertFixedFields(metrics);
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("ordinary saturation and drain emit unsampled busy while actual work and responses keep their existing ownership", async (t) => {
  const metrics = capture(t, 0.99);
  const source = fixture({ maxInflight: 1 });
  let drained: Promise<void> | undefined;
  try {
    assert.equal(await consumed(await source.request()), 200);
    assert.deepEqual(metrics, [], "hot admissions are sampled rather than logged per request");
    const busy = await source.request();
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("Retry-After"), "1");
    assert.deepEqual(await busy.json(), { error: { code: "busy" } });
    drained = source.backend.drain();
    assert.equal(await consumed(await source.request()), 503);
    assert.deepEqual(labels(metrics), [
      { lane: "ordinary", outcome: "busy", cause: "capacity" },
      { lane: "ordinary", outcome: "busy", cause: "draining" },
    ]);
    assert.equal(source.owners.length, 1);
    assert.equal(source.nonces(), 1);
    assertFixedFields(metrics);
  } finally {
    source.work.resolve();
    await (drained ?? source.backend.drain());
  }
});

test("verified resource observations distinguish fixed quote work and retain the existing lane capacities", async (t) => {
  const metrics = capture(t);
  for (const [lane, maximum, path, method, work] of [
    ["quote", 4, "/api/social/trades/quote", "POST", "quote"],
    ["trade", 4, "/api/social/trades", "POST", "other"],
    ["long-work", 4, "/api/social/me/wallet", "GET", "other"],
    ["upload", 2, "/api/social/me/profile/picture", "PUT", "other"],
    ["render", 2, "/presale/synthetic/share-image", "GET", "other"],
    ["allowlist", 1, "/api/presale/allowlists", "POST", "other"],
  ] as const) {
    const source = fixture();
    const start = metrics.length;
    try {
      for (let i = 0; i < maximum; i++) {
        assert.equal(await consumed(await source.request(path, method)), 200);
      }
      const busy = await source.request(path, method);
      assert.equal(busy.status, 503);
      assert.equal(busy.headers.get("Retry-After"), lane === "quote" ? "5" : "1");
      assert.equal((await busy.json()).error.code, lane === "quote" ? "quote_busy" : "busy");
      const observed = labels(metrics.slice(start).filter((metric) => metric.lane === lane));
      assert.deepEqual(observed, [
        ...Array.from({ length: maximum }, () => ({
          lane,
          outcome: "admitted",
          work,
          sampleRate: 0.02,
        })),
        { lane, outcome: "busy", work, cause: "lane" },
      ]);
      assert.equal(source.owners.length, maximum);
      assert.equal(source.nonces(), maximum);
      source.work.resolve();
      await pause(0);
      assert.equal(
        await consumed(await source.request(path, method)),
        200,
        "only actual settlement releases resource admission",
      );
    } finally {
      source.work.resolve();
      await source.backend.drain();
    }
  }
  assertFixedFields(metrics);
});

test("mixed aggregate refusal is observable without claiming executor activity or changing independent budgets", async (t) => {
  const metrics = capture(t);
  const source = fixture();
  try {
    for (const [count, path, method] of [
      [2, "/presale/synthetic/share-image", "GET"],
      [2, "/api/social/me/profile/picture", "PUT"],
      [2, "/api/social/trades/quote", "POST"],
      [2, "/api/social/trades", "POST"],
    ] as const) {
      for (let i = 0; i < count; i++) {
        assert.equal(await consumed(await source.request(path, method)), 200);
      }
    }
    assert.equal(await consumed(await source.request("/api/social/me/wallet", "GET")), 503);
    assert.deepEqual(labels(metrics).at(-1), {
      lane: "long-work",
      outcome: "busy",
      work: "other",
      cause: "aggregate",
    });
    assert.equal(source.owners.length, 8);
    assert.equal(source.nonces(), 8);
    assert.equal(await consumed(await source.request("/api/social/me", "GET")), 200);
    assert.equal(await consumed(await source.health()), 200);
    assertFixedFields(metrics);
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("readiness observations count reserved permits rather than coalesced dependency calls", async (t) => {
  const metrics = capture(t);
  const gate = deferred();
  let dependencies = 0;
  const source = fixture({
    ready: async () => {
      dependencies++;
      await gate.promise;
      return true;
    },
  });
  try {
    const pending = Array.from({ length: 8 }, () => source.health());
    await pause(0);
    assert.equal(await consumed(await source.health()), 503);
    assert.equal(dependencies, 1);
    assert.deepEqual(labels(metrics), [
      ...Array.from({ length: 8 }, () => ({
        lane: "readiness",
        outcome: "admitted",
        sampleRate: 0.02,
      })),
      { lane: "readiness", outcome: "busy", cause: "capacity" },
    ]);
    gate.resolve();
    assert.deepEqual(
      await Promise.all(pending.map(async (reply) => consumed(await reply))),
      Array(8).fill(200),
    );
    await source.backend.drain();
    assert.equal(await consumed(await source.health()), 503);
    assert.deepEqual(labels(metrics).at(-1), {
      lane: "readiness",
      outcome: "busy",
      cause: "draining",
    });
    assertFixedFields(metrics);
  } finally {
    gate.resolve();
    await source.backend.drain();
  }
});

test("authenticated hint observations describe admission before the owner and retain actual work", async (t) => {
  const metrics = capture(t);
  const source = fixture({ maxHintStreams: 1 });
  try {
    assert.equal(await consumed(await source.request("/api/social/activity/hints", "GET")), 200);
    assert.equal(await consumed(await source.request("/api/social/activity/hints", "GET")), 503);
    assert.deepEqual(labels(metrics.filter((metric) => metric.lane === "hint")), [
      { lane: "hint", outcome: "admitted", sampleRate: 0.02 },
      { lane: "hint", outcome: "busy", cause: "capacity" },
    ]);
    assert.equal(source.owners.length, 1);
    assert.equal(source.nonces(), 1);
    source.work.resolve();
    await pause(0);
    assert.equal(await consumed(await source.request("/api/social/activity/hints", "GET")), 200);
    assertFixedFields(metrics);
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("partner preparation is not mislabeled as ordinary or full tenant-owner admission", async (t) => {
  const metrics = capture(t);
  const source = fixture({ preparePartner: async () => null });
  try {
    assert.equal(
      await consumed(
        await source.backend.fetch(new Request(backendOrigin + "/api/v1/unknown"), "127.0.0.1"),
      ),
      200,
    );
    assert.deepEqual(metrics, []);
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});

test("failed metric sampling and logging cannot replace work, refusals or capacity release", async (t) => {
  capture(t);
  const source = fixture();
  try {
    Math.random = () => {
      throw new Error("sampler failed");
    };
    console.info = () => {
      throw new Error("sink failed");
    };
    for (let i = 0; i < 4; i++) {
      assert.equal(await consumed(await source.request()), 200);
    }
    const refused = await source.request();
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("Retry-After"), "5");
    assert.equal((await refused.json()).error.code, "quote_busy");
    assert.equal(source.owners.length, 4);
    assert.equal(source.nonces(), 4);
    assert.equal(await consumed(await source.health()), 200);
    source.work.resolve();
    await pause(0);
    assert.equal(await consumed(await source.request()), 200);
  } finally {
    source.work.resolve();
    await source.backend.drain();
  }
});
