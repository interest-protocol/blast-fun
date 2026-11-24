import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import type { Pool } from "pg";
import { createPublicReadCache } from "@blast/core/lib/public-read-cache.ts";
import { configuredRedis } from "@blast/core/lib/redis.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool, primaryPool, partnerVerifierPool } from "@blast/core/modules/database/pool.ts";
import { blastInfraFetch } from "@blast/core/modules/read-routing/blast-infra.ts";
import { configuredPartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import {
  createPartner,
  issuePartnerApiKey,
  partnerKeyReader,
  revokePartnerApiKey,
  setPartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/repository.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { urlAs } from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { endProcessPools } from "../../../packages/core/test/fixtures/modules/database/testing.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const redisUrl = process.env.BLAST_TEST_REDIS_URL;
const PEPPER = "runtime-test-pepper-012345678901234567890123456789";
const WRITER = "https://writer.blast.test";
const READER = "https://reader.blast.test";
const ACTIVITY = `/v1/launches/0x${"a".repeat(64)}/activity`;

type Read = PartnerV1Handlers["presales"];

// Production partner recognition requires quota Redis, so both owned stores are mandatory: no skip.
test("production partner admission applies custom caps, policy changes and fresh revocation through Redis", async (t) => {
  assert.ok(databaseUrl, "An owned disposable primary is mandatory.");
  assert.ok(redisUrl, "An owned disposable Valkey is mandatory.");
  assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
  assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
  const environment = {
    BLAST_QUOTA_REDIS_URL: redisUrl,
    BLAST_CACHE_REDIS_URL: redisUrl,
    BLAST_REDIS_NAMESPACE: `runtime:${randomUUID()}`,
    BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["runtime-path"]),
    DATABASE_URL: urlAs(databaseUrl, "blast_web"),
    DATABASE_REPLICA_URL: "postgresql://reader:unused@127.0.0.1:9/never_connected",
    RATE_LIMIT_SUBJECT_PEPPER: PEPPER,
  };
  const previous = Object.fromEntries(
    [...Object.keys(environment), "PARTNER_VERIFIER_DATABASE_URL"].map((name) => [
      name,
      process.env[name],
    ]),
  );
  Object.assign(process.env, environment);
  const admin = createPool(databaseUrl, { max: 1 });
  // The backend's recognition reads publications on its own primary pool, as main.ts does.
  const backendPrimary = createPool(environment.DATABASE_URL, { max: 1 });
  t.after(async () => {
    configuredRedis("quota")?.close();
    configuredRedis("cache")?.close();
    await endProcessPools();
    await backendPrimary.end();
    await admin.end();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
  const clock = (await configuredRedis("quota")!.execute(["TIME"])) as string[];
  const remaining = 60 - (Number(clock[0]) % 60);
  if (remaining < 5) {
    await setTimeout(remaining * 1_000 + 50);
  }
  await migrateDatabase(admin);
  // Fresh verification uses only the narrowly granted login; the writer URL is never substituted.
  process.env.PARTNER_VERIFIER_DATABASE_URL = await partnerVerifierFixture(databaseUrl, t);
  await createPartner(backendPrimary, { id: "runtime-path", origins: [] }, "operator:test-ops");
  const issued = await issuePartnerApiKey(
    backendPrimary,
    "runtime-path",
    "custom",
    "operator:test-ops",
  );
  await setPartnerKeyPolicy(
    backendPrimary,
    issued.id,
    { tier: "custom", requestsPerMinute: 3, requestsPerDay: 4 },
    "operator:test-ops",
  );
  await warmCache();
  const redisCache = createPublicReadCache(
    configuredRedis("cache")!,
    environment.BLAST_REDIS_NAMESPACE,
    PEPPER,
  );
  const partner = await productionPartnerApi(backendPrimary);

  // Real fresh primary authorization and real Redis counters are unchanged as the downstream
  // transport is switched. Only the product data is synthetic.
  let independent = false;
  let loads = 0;
  const transports: string[] = [];
  partner.read.presales = async () => {
    const transport = blastInfraFetch({
      origin: WRITER,
      environment: {
        BLAST_INFRA_API_KEY: "synthetic-infra-transport-key-0123456789",
        BLAST_INFRA_READ_ORIGIN: READER,
        BLAST_INFRA_READ_MODE: independent ? "committed-markets" : "",
      },
      fetch: (async (input) => {
        transports.push(new URL(String(input)).origin);
        return Response.json({ public: true });
      }) as typeof fetch,
    });
    assert.equal((await transport(`${WRITER}${ACTIVITY}`)).status, 200);
    return Response.json(
      await redisCache(
        "public-data",
        async () => {
          loads++;
          return { public: true };
        },
        10_000,
      ),
    );
  };
  const call = (useReader = false) => {
    independent = useReader;
    return partner.send("/api/v1/presales", issued.key);
  };
  for (let index = 0; index < 3; index++) {
    assert.equal((await call(index === 1)).status, 200);
  }
  assert.deepEqual(transports, [WRITER, READER, WRITER]);
  const refusal = await call(true);
  assert.equal(refusal.status, 429);
  assert.ok(refusal.headers.get("retry-after"));
  assert.equal(
    transports.length,
    3,
    "Switching upstream cannot reset the counter or transport a refused call",
  );
  await setPartnerKeyPolicy(
    backendPrimary,
    issued.id,
    { tier: "custom", requestsPerMinute: 4, requestsPerDay: 4 },
    "operator:test-ops",
  );
  assert.equal(
    (await call()).status,
    200,
    "Fresh policy changes reach admission without clearing counters",
  );
  assert.equal((await call()).status, 429);
  await setPartnerKeyPolicy(backendPrimary, issued.id, { tier: "internal" }, "operator:test-ops");
  assert.equal((await call(true)).status, 200, "Internal keys bypass partner quotas");
  await revokePartnerApiKey(backendPrimary, issued.id, "operator:test-ops");
  assert.equal((await call()).status, 401);
  assert.equal(
    transports.length,
    5,
    "Exactly one downstream fetch per admitted call, including policy change/internal tier",
  );
  assert.equal(loads, 1, "Cache hits consume quota and revoked keys never reach cached data");

  await verifyVersionedRevocation(backendPrimary, partner, redisCache);

  const verifier = partnerVerifierPool();
  assert.notEqual(verifier, backendPrimary);
  assert.equal(verifier.options.max, 2);
  assert.ok(verifier.totalCount > 0, "Fresh verification ran on the dedicated verifier pool");
  assert.equal(
    new URL(verifier.options.connectionString!).username,
    new URL(process.env.PARTNER_VERIFIER_DATABASE_URL!).username,
  );
  assert.equal(
    primaryPool().totalCount,
    0,
    "Admission used the dedicated verifier and the backend's injected primary",
  );
});

/** A warm cache cannot answer for a revoked key: admission stops the versioned handler first. */
async function verifyVersionedRevocation(
  writer: Pool,
  partner: Awaited<ReturnType<typeof productionPartnerApi>>,
  redisCache: ReturnType<typeof createPublicReadCache>,
) {
  const routeKey = await issuePartnerApiKey(
    writer,
    "runtime-path",
    "versioned route",
    "operator:test-ops",
  );
  await setPartnerKeyPolicy(writer, routeKey.id, { tier: "internal" }, "operator:test-ops");
  let handlerCalls = 0;
  let sourceReads = 0;
  partner.read.featured = async () => {
    handlerCalls++;
    return Response.json(
      await redisCache(
        "route:featured",
        async () => {
          sourceReads++;
          return [{ public: true }];
        },
        10_000,
      ),
    );
  };
  for (let index = 0; index < 2; index++) {
    const response = await partner.send("/api/v1/presales/featured", routeKey.key);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), [{ public: true }]);
  }
  assert.equal(sourceReads, 1);
  await revokePartnerApiKey(writer, routeKey.id, "operator:test-ops");
  assert.equal((await partner.send("/api/v1/presales/featured", routeKey.key)).status, 401);
  assert.equal(
    handlerCalls,
    2,
    "Revocation must stop the versioned handler before a warm cache can answer",
  );
}

/**
 * The backend's production partner wiring (main.ts): configured recognition, the verifier-pool
 * key reader and quota Redis. Each test swaps in the product reads it needs.
 */
async function productionPartnerApi(backendPrimary: Pool) {
  const unexpected: Read = async () => {
    throw new Error("Unexpected versioned handler");
  };
  const read: Record<"presales" | "featured", Read> = {
    presales: unexpected,
    featured: unexpected,
  };
  const recognition = configuredPartnerRecognition(backendPrimary);
  await recognition.reconcile();
  assert.equal(recognition.ready(), true);
  const api = createBackendApi({
    keys: partnerKeyReader,
    recognition,
    redis: configuredRedis("quota")!,
    namespace: quotaNamespace(process.env.BLAST_REDIS_NAMESPACE, deploymentIdentity(process.env)),
    subjectPepper: PEPPER,
    handlers: () => ({
      defillama: unexpected,
      daily_stats: unexpected,
      presales: (request, client) => read.presales(request, client),
      featured: (request, client) => read.featured(request, client),
      presale: unexpected,
      prices: unexpected,
      search: unexpected,
      discovery: unexpected,
      wallet_launches: unexpected,
      presale_proof: unexpected,
      coin_metadata: unexpected,
      market: unexpected,
    }),
  });

  return { read, send };

  async function send(path: string, key: string): Promise<Response> {
    const prepared = await api.preparePartner(
      new Request(`https://backend.test${path}`, {
        headers: { "x-blast-partner-key": key },
      }),
      testClient("198.18.0.30"),
    );
    assert.ok(prepared);
    if (prepared.response) {
      return prepared.response;
    }
    try {
      return await prepared.handle();
    } finally {
      prepared.release();
    }
  }
}

async function warmCache() {
  for (let attempt = 0; ; attempt++) {
    try {
      await configuredRedis("cache")!.execute(["PING"]);
      return;
    } catch (error) {
      if (attempt >= 100) {
        throw error;
      }
      await setTimeout(10);
    }
  }
}
