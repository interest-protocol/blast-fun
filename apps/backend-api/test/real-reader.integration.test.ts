import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createServer } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { importPKCS8, SignJWT } from "jose";
import { Pool } from "pg";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { parseInfraProvenance } from "@blast/core/modules/launchpad-contract/provenance.ts";
import {
  createPartner,
  issuePartnerApiKey,
  setPartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/repository.ts";
import { readRealReaderFixture } from "./real-reader-fixture.ts";
import { mixedReadProfile } from "./mixed-read-profile.ts";
import {
  localReplicaUrl,
  RUNTIME_TEST_ENVIRONMENT,
} from "../../../packages/server/test/fixtures/config/runtime-config.ts";

type Body = Record<string, unknown>;
const marketData = (body: Body) =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== "provenance"));

async function json(
  origin: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Body> {
  const response = await fetch(origin + path, {
    headers,
    signal: AbortSignal.timeout(5_000),
    redirect: "error",
  });
  assert.equal(response.status, 200, `Expected a real successful read at ${path}`);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const body = (await response.json()) as Body;
  assert.ok(body && typeof body === "object" && !Array.isArray(body));
  assert.equal(
    body.fixture,
    undefined,
    "A tiny fixture response cannot stand in for the Rust reader.",
  );
  return body;
}

async function freePort(): Promise<number> {
  const listener = createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((done) => listener.close(() => done()));
  return port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  await ended;
  clearTimeout(timer);
}

test(
  "real release Rust reader serves admitted partners and existing-session frontend reads",
  { timeout: 165_000 },
  async (t) => {
    const setupStarted = performance.now();
    const fixture = readRealReaderFixture(process.env.BLAST_BACKEND_READER_HANDOFF);
    const infraKey = process.env.BLAST_BACKEND_READER_TEST_API_KEY;
    assert.ok(
      infraKey && /^[\x21-\x7e]{32,512}$/.test(infraKey),
      "An explicit synthetic reader key is mandatory.",
    );
    const database = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
    const redisUrl = process.env.BLAST_TEST_REDIS_URL;
    assert.ok(
      database && redisUrl,
      "Run through verify-backend-real-reader.mjs with disposable PostgreSQL and Valkey.",
    );
    assert.equal(new URL(database).hostname, "127.0.0.1");
    assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
    const pool = new Pool({ connectionString: database, max: 1 });
    const redis = createRedisConnection(redisUrl, "quota");
    t.after(async () => {
      redis.close();
      await pool.end();
    });
    await migrateDatabase(pool);
    const recognitionEnvironment = {
      BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
      BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["real-reader-bridge"]),
      BLAST_QUOTA_REDIS_URL: redisUrl,
      BLAST_REDIS_NAMESPACE: `recognition-fixture:${randomUUID()}`,
      RATE_LIMIT_SUBJECT_PEPPER: "synthetic-recognition-fixture-pepper-01234567890123456789",
      BLAST_DEPLOYMENT_TARGET: "preview",
      BLAST_DEPLOYMENT_BRANCH: "recognition-fixture",
    };
    const priorEnvironment = Object.fromEntries(
      Object.keys(recognitionEnvironment).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, recognitionEnvironment);
    t.after(() => {
      for (const [name, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    });
    await createPartner(pool, { id: "real-reader-bridge", origins: [] }, "operator:test");
    const partner = await issuePartnerApiKey(
      pool,
      "real-reader-bridge",
      "actual-rust-reader",
      "operator:test",
    );
    await setPartnerKeyPolicy(
      pool,
      partner.id,
      { tier: "custom", requestsPerMinute: 4, requestsPerDay: 4 },
      "operator:test",
    );
    const accountCount = (await pool.query("SELECT count(*)::text AS count FROM social_accounts"))
      .rows[0].count;
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signingKey = await importPKCS8(
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "ES256",
    );
    const environment = {
      ...RUNTIME_TEST_ENVIRONMENT,
      PATH: process.env.PATH,
      NODE_ENV: "test",
      TZ: "UTC",
      DATABASE_URL: database,
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
      DATABASE_REPLICA_URL: localReplicaUrl(database),
      ...recognitionEnvironment,
      BLAST_BACKEND_INGRESS_MODE: "direct",
      BLAST_BACKEND_GATEWAY_SECRET: "real-reader-synthetic-gateway-012345678901234567890123",
      BLAST_INFRA_ORIGIN: fixture.writer_origin,
      BLAST_INFRA_READ_ORIGIN: fixture.reader_origin,
      BLAST_INFRA_READ_MODE: "committed-markets",
      BLAST_INFRA_API_KEY: infraKey,
      NEXT_PUBLIC_SITE_URL: "https://frontend.test",
      PRIVY_APP_ID: "real-reader-existing-app",
      PRIVY_JWT_VERIFICATION_KEY: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      BLAST_DEPLOYMENT_TARGET: "preview",
      BLAST_DEPLOYMENT_BRANCH: "isolated-real-reader",
    };
    Object.assign(environment, recognitionEnvironment);
    let captured = "";

    async function start(file: string, extra: Record<string, string> = {}) {
      const port = await freePort();
      const child = fork(new URL(file, import.meta.url), [], {
        execPath: process.execPath,
        execArgv: ["--no-env-file"],
        env: { ...environment, PORT: String(port), ...extra },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.stdout!.on("data", (chunk) => {
        captured = (captured + chunk.toString()).slice(-100_000);
      });
      child.stderr!.on("data", (chunk) => {
        captured = (captured + chunk.toString()).slice(-100_000);
      });
      t.after(() => stop(child));
      const origin = `http://127.0.0.1:${port}`;
      // A failed health probe is cached for 5 s, so readiness may need longer than socket startup.
      for (
        let attempt = 0, limit = file.includes("benchmark-process") ? 500 : 150;
        attempt < limit;
        attempt++
      ) {
        assert.equal(child.exitCode, null, "Bridge child exited before readiness.");
        // The benchmark replica takes traffic only once ready, like behind a load balancer.
        const probe = file.includes("relay-process")
          ? "/api/v1/unknown"
          : file.includes("benchmark-process")
            ? "/v1/health"
            : "/v1/live";
        try {
          const { status } = await fetch(origin + probe, { signal: AbortSignal.timeout(250) });
          if (probe === "/v1/health" ? status === 200 : status > 0) {
            return { origin, child };
          }
        } catch {
          /* Bounded socket startup. */
        }
        await pause(30);
      }
      throw new Error("Real-reader bridge process did not become ready.");
    }

    const main = await start("../src/main.ts");
    const frontend = await start("./relay-process.ts", { TEST_BACKEND_ORIGIN: main.origin });
    const backend = main.origin;
    const relay = frontend.origin;
    const sourceHeaders = { "x-blast-infra-key": infraKey };

    function provenance(body: Body) {
      const stamp = parseInfraProvenance(body.provenance);
      assert.equal(stamp.network, fixture.network);
      assert.equal(stamp.deployment, fixture.deployment_fingerprint);
      assert.ok(stamp.checkpoint !== null && stamp.checkpoint > 0 && stamp.timestampMs !== null);
      return stamp;
    }

    const pools = await json(fixture.reader_origin, "/v1/pools?limit=100", sourceHeaders);
    provenance(pools);
    assert.ok(Array.isArray(pools.pools) && pools.pools.length > 0);
    const selected = (pools.pools as Body[]).find(
      (row) =>
        fixture.pool_keys.includes(String(row.pool_key)) &&
        String(row.pool_key).startsWith("blast_curve:"),
    );
    assert.ok(
      selected && typeof selected.coin === "string",
      "Real committed discovery must contain a fixture launch curve.",
    );
    const poolId = String(selected.pool_key).slice("blast_curve:".length);
    const coin = await json(
      fixture.reader_origin,
      `/v1/coins/${encodeURIComponent(selected.coin)}`,
      sourceHeaders,
    );
    provenance(coin);
    const traders = await json(fixture.reader_origin, "/v1/traders/top?limit=20", sourceHeaders);
    provenance(traders);
    assert.ok(
      Array.isArray(traders.traders),
      "Real top-trader response must use its published array shape.",
    );
    const partnerHeaders = { "x-blast-partner-key": partner.key };
    const clock = (await redis.execute(["TIME"])) as string[];
    const windowLeft = 60 - (Number(clock[0]) % 60);
    if (windowLeft < 12) {
      await pause(windowLeft * 1_000 + 50);
    }
    let expectedPool: Body | undefined;
    const expectedData = new Map<string, Body>();
    for (const path of [
      `/pools/blast_curve/${poolId}`,
      `/coins/${encodeURIComponent(selected.coin)}/holders?view=snapshot&limit=20`,
    ]) {
      const source = await json(fixture.reader_origin, "/v1" + path, sourceHeaders);
      const stamp = provenance(source);
      expectedData.set(path, marketData(source));
      const direct = await json(backend, "/api/v1/market" + path, partnerHeaders);
      const relayed = await json(relay, "/api/v1/market" + path, partnerHeaders);
      assert.deepEqual(
        direct,
        relayed,
        "Canonical direct and signed frontend relay return the exact same cached Rust body.",
      );
      assert.equal(provenance(direct).checkpoint, stamp.checkpoint);
      assert.deepEqual(
        marketData(direct),
        marketData(source),
        "Real market payload is preserved; only source observation time may advance.",
      );
      if (path.startsWith("/pools/")) {
        expectedPool = direct;
      }
    }
    const counters = (await redis.execute([
      "KEYS",
      `${quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment))}:*:partner_read:*`,
    ])) as string[];
    assert.equal(counters.length, 2, "The original minute/day key counter identities are reused.");
    for (const counter of counters) {
      assert.match(String(await redis.execute(["GET", counter])), /:4$/);
    }
    const token = await new SignJWT({ sid: "existing-real-reader-session" })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("privy.io")
      .setAudience(environment.PRIVY_APP_ID)
      .setSubject("did:privy:existing-real-reader-account")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);
    const own = await json(relay, `/api/launchpad/market/pools/blast_curve/${poolId}`, {
      authorization: `Bearer ${token}`,
      origin: "https://frontend.test",
      "sec-fetch-site": "same-origin",
    });
    provenance(own);
    assert.ok(expectedPool);
    assert.deepEqual(marketData(own), marketData(expectedPool));
    for (const counter of counters) {
      assert.match(
        String(await redis.execute(["GET", counter])),
        /:4$/,
        "Public anonymous frontend reads do not consume commercial partner budgets.",
      );
    }
    const refused = await fetch(backend + `/api/v1/market/pools/blast_curve/${poolId}`, {
      headers: partnerHeaders,
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(
      refused.status,
      429,
      "Four direct/relay reads exhaust exactly four partner allowances.",
    );
    await refused.body?.cancel();
    assert.equal(
      (await pool.query("SELECT count(*)::text AS count FROM social_accounts")).rows[0].count,
      accountCount,
    );
    await pause(30);
    assert.match(captured, /"caller":"anonymous"/);
    for (const secret of [token, partner.key, infraKey]) {
      assert.equal(captured.includes(secret), false);
    }
    const originalDailyCounters = counters.filter((counter) => counter.endsWith(":86400"));
    const originalDailyValues = await Promise.all(
      originalDailyCounters.map((counter) => redis.execute(["GET", counter])),
    );
    // Keep the production-policy correctness proof intact; capacity has its own synthetic namespace and limits.
    await stop(frontend.child);
    await stop(main.child);
    await setPartnerKeyPolicy(
      pool,
      partner.id,
      { tier: "custom", requestsPerMinute: 100_000, requestsPerDay: 100_000 },
      "operator:test",
    );
    const capacityEnvironment = {
      BLAST_REDIS_NAMESPACE: environment.BLAST_REDIS_NAMESPACE + ":capacity",
      MISSION_CONTROL_METRICS: "off",
    };
    const capacity = await start("./benchmark-process.ts", capacityEnvironment);
    const capacityRelay = await start("./relay-process.ts", {
      ...capacityEnvironment,
      TEST_BACKEND_ORIGIN: capacity.origin,
    });
    assert.ok(
      performance.now() - setupStarted < 30_000,
      "Setup must leave120s workload plus cleanup within165s test/180s runner.",
    );
    const statsBefore = await json(capacity.origin, "/test/process-stats");
    const paths = [...expectedData.keys()];
    const userHeaders = {
      authorization: `Bearer ${token}`,
      origin: "https://frontend.test",
      "sec-fetch-site": "same-origin",
    };
    const observations = new Map<string, { last: number; repeats: number; changes: number }>();
    const rss = { backendPeakSampledKiB: 0, relayPeakSampledKiB: 0, samples: 0 };

    function sampleMemory() {
      for (const [child, field] of [
        [capacity.child, "backendPeakSampledKiB"],
        [capacityRelay.child, "relayPeakSampledKiB"],
      ] as const) {
        const value = Number(
          /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"))?.[1],
        );
        assert.ok(Number.isFinite(value) && value > 0, "Actual live child RSS is mandatory.");
        rss[field] = Math.max(rss[field], value);
      }
      rss.samples++;
    }

    sampleMemory();
    let memoryError = false;
    const sampler = setInterval(() => {
      try {
        sampleMemory();
      } catch {
        memoryError = true;
      }
    }, 1_000);
    const iterations = Array(8).fill(0) as number[];
    let profile: Awaited<ReturnType<typeof mixedReadProfile>>;
    try {
      profile = await mixedReadProfile({
        durationMs: 120_000,
        labels: [
          "partner_direct",
          "partner_direct",
          "partner_relay",
          "partner_relay",
          "verified_user",
          "verified_user",
          "verified_user",
          "verified_user",
        ],
        async request(worker) {
          const path = paths[iterations[worker]++ % paths.length];
          const user = worker >= 4;
          const origin = worker < 2 ? capacity.origin : capacityRelay.origin;
          const response = await fetch(
            origin + (user ? "/api/launchpad/market" : "/api/v1/market") + path,
            {
              headers: user ? userHeaders : partnerHeaders,
              signal: AbortSignal.timeout(5_000),
              redirect: "error",
            },
          );
          if (response.status !== 200) {
            await response.body?.cancel();
            return { status: response.status };
          }
          try {
            const body = (await response.json()) as Body;
            const stamp = provenance(body);
            assert.equal(body.fixture, undefined);
            assert.deepEqual(marketData(body), expectedData.get(path));
            const previous = observations.get(path);
            observations.set(path, {
              last: stamp.observedAt,
              repeats: (previous?.repeats ?? 0) + Number(previous?.last === stamp.observedAt),
              changes:
                (previous?.changes ?? 0) +
                Number(previous !== undefined && previous.last !== stamp.observedAt),
            });
            return { status: 200 };
          } catch {
            return { status: 200, error: "validation" };
          }
        },
      });
    } finally {
      clearInterval(sampler);
    }
    sampleMemory();
    const statsAfter = await json(capacity.origin, "/test/process-stats");
    const partnerAttempts =
      profile.groups.partner_direct.attempts + profile.groups.partner_relay.attempts;
    const primaryKeyReads =
      Number(statsAfter.primaryKeyReads) - Number(statsBefore.primaryKeyReads);
    const redisCommands = Number(statsAfter.redisCommands) - Number(statsBefore.redisCommands);
    const capacityNamespace = quotaNamespace(
      capacityEnvironment.BLAST_REDIS_NAMESPACE ?? environment.BLAST_REDIS_NAMESPACE,
      deploymentIdentity({ ...environment, ...capacityEnvironment }),
    );
    const capacityCounters = (await redis.execute([
      "KEYS",
      `${capacityNamespace}:*:partner_read:*`,
    ])) as string[];
    const daily = capacityCounters.filter((key) => key.endsWith(":86400"));
    const capacityDaily =
      daily.length === 1 ? String(await redis.execute(["GET", daily[0]])) : "missing";
    const originalCountersUnchanged =
      JSON.stringify(
        await Promise.all(originalDailyCounters.map((counter) => redis.execute(["GET", counter]))),
      ) === JSON.stringify(originalDailyValues);
    const originalMinuteExpiredNormally =
      (await redis.execute(["GET", counters.find((counter) => counter.endsWith(":60"))!])) === null;
    const accountCountUnchanged =
      (await pool.query("SELECT count(*)::text AS count FROM social_accounts")).rows[0].count ===
      accountCount;
    t.diagnostic(
      JSON.stringify({
        runtime: { name: "Bun", version: Bun.version },
        actualRustMixedProfile: profile,
        syntheticCapacityLimits: 100_000,
        originalFourReadProofRetained: true,
        primaryKeyReads,
        redisCommands,
        capacityDailyCount: Number(capacityDaily.split(":").at(-1)),
        originalCountersUnchanged,
        originalMinuteExpiredNormally,
        accountCountUnchanged,
        memory: { ...rss, backendPeakReportedKiB: statsAfter.peakRssKb },
        cacheObservations: Object.fromEntries(observations),
        cacheScope:
          "Normal five-second public cache; repeated/changing source observation times are not exact hit/miss counters or database-cold proof.",
        topology:
          "One declared actual Rust reader; no invented delayed reader; closed-loop clients; not hosted capacity/SLO.",
      }),
    );
    assert.equal(memoryError, false);
    for (const group of Object.values(profile.groups)) {
      assert.ok(group.attempts > 0);
      assert.equal(group.valid, group.attempts);
      assert.deepEqual(group.errors, {});
    }
    assert.equal(
      primaryKeyReads,
      partnerAttempts,
      "Every partner attempt performed fresh primary key authorization.",
    );
    assert.ok(
      redisCommands >= partnerAttempts * 2 + profile.groups.verified_user.attempts,
      "Actual admission/replay commands remain in the end-to-end path.",
    );
    assert.equal(
      Number(capacityDaily.split(":").at(-1)),
      partnerAttempts,
      "Successful direct/relay partner reads charge exactly once; verified users spend none.",
    );
    assert.equal(originalCountersUnchanged, true);
    assert.equal(originalMinuteExpiredNormally, true);
    assert.equal(accountCountUnchanged, true);
    t.diagnostic(
      JSON.stringify({
        actualRustReader: true,
        network: fixture.network,
        binarySha256: fixture.binary_sha256,
        readerProvenanceVerified: true,
        realDiscoveryCoinTopTraders: true,
        directRelayBodyParity: true,
        fourReadsFourCharges: true,
        genuineExistingSession: true,
        accountCountUnchanged: true,
      }),
    );
  },
);
