import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import { waitForHealth } from "./kit.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFile, readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { Pool } from "pg";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import { syntheticCapacity } from "@blast/server/modules/partner-api-keys/capacity.test.ts";
import {
  generatePartnerApiKey,
  hashPartnerApiKey,
} from "@blast/server/modules/partner-api-keys/contracts.ts";
import {
  PARTNER_RECOGNITION_LOCK,
  PartnerRecognition,
} from "@blast/server/modules/partner-api-keys/recognition.ts";
import { PartnerRecognitionStore } from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import { createPartnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";
import {
  localReplicaUrl,
  RUNTIME_TEST_ENVIRONMENT,
} from "../../../packages/server/test/fixtures/config/runtime-config.ts";

// Local resilience measurements on owned disposable PostgreSQL/Valkey and two
// actual native Bun replicas. Short local runs, never fleet percentiles or SLOs.
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const redisUrl = process.env.BLAST_TEST_REDIS_URL;
const redisContainer = process.env.BLAST_TEST_REDIS_CONTAINER;
const evidence = process.env.RECOGNITION_RESILIENCE_EVIDENCE;
const pepper = "synthetic-resilience-pepper-0123456789012345678901";

type Sample = Readonly<{
  at: number;
  status: number;
  ms: number;
  code?: string;
}>;

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) =>
    sorted.length
      ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] * 10) / 10
      : null;
  return {
    n: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
  };
}

function statuses(samples: readonly Sample[]) {
  const counts: Record<string, number> = {};
  for (const sample of samples) {
    const label = sample.code ? `${sample.status}:${sample.code}` : String(sample.status);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

async function record(name: string, value: unknown): Promise<void> {
  const line = JSON.stringify({ measurement: name, ...(value as object) });
  console.log(line);
  if (evidence) {
    await appendFile(evidence, line + "\n");
  }
}

/** Two actual native backend processes on free loopback ports, each healthy before return. */
async function launchReplicas(
  environment: Record<string, string | undefined>,
  children: ChildProcess[],
) {
  const logs = ["", ""];
  const origins: string[] = [];
  for (let replica = 0; replica < 2; replica++) {
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const port = (portServer.address() as { port: number }).port;
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    const child = spawn(
      process.execPath,
      ["--no-env-file", new URL("../src/main.ts", import.meta.url).pathname],
      {
        cwd: process.cwd(),
        env: { ...environment, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.on("data", (chunk) => {
        logs[replica] += chunk.toString();
      });
    }
    origins.push(`http://127.0.0.1:${port}`);
    await waitForHealth(child, origins[replica], 40_000);
  }
  return { logs, origins };
}

test(
  "recognition stays available through primary contention and recovers promptly from a Redis pause",
  {
    skip: databaseUrl && redisUrl ? false : "Disposable primary and Redis required",
  },
  async (t) => {
    assert.ok(databaseUrl && redisUrl);
    for (const url of [databaseUrl, redisUrl]) {
      assert.equal(new URL(url).hostname, "127.0.0.1");
    }
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const dbName = "resilience_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE DATABASE ${dbName}`);
    const target = new URL(databaseUrl);
    target.pathname = "/" + dbName;
    const pool = new Pool({ connectionString: String(target), max: 2 });
    const redis = createRedisConnection(redisUrl, "quota");
    const namespace = "test:" + randomUUID();
    const capacity = partnerCapacity(JSON.stringify(syntheticCapacity));
    const store = new PartnerRecognitionStore(redis, namespace, pepper, capacity);
    const coordinator = new PartnerRecognition(pool, store);
    const children: ChildProcess[] = [];
    t.after(async () => {
      for (const child of children) {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }
      await Promise.all(
        children.map((child) => (child.exitCode === null ? once(child, "exit") : null)),
      );
      redis.close();
      await pool.end();
      await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
      await admin.end();
    });
    await pool.query(
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='blast_web') THEN CREATE ROLE blast_web NOLOGIN; END IF; END $$",
    );
    for (const migration of [
      "0124_partner_api_keys",
      "0127_partner_key_tiers",
      "0129_partner_admin_deletion",
      "0131_partner_recognition_marker",
      "0132_partner_verifier_role",
    ]) {
      await pool.query(
        await readFile(
          new URL(
            `../../../packages/core/src/modules/database/migrations/${migration}.up.sql`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    }
    await pool.query(
      "INSERT INTO partner_api_partners(id,origins,created_by,updated_by) VALUES ('quiet',ARRAY['https://quiet.example'],'operator:test','operator:test'),('noisy',ARRAY[]::text[],'operator:test','operator:test')",
    );
    // Standard tier: partner_read 300/min per key; every scenario stays far below it.
    const key = generatePartnerApiKey();
    const keyId = randomUUID();
    const revocable = Array.from({ length: 3 }, () => ({
      key: generatePartnerApiKey(),
      id: randomUUID(),
    }));
    await coordinator.reconcile();
    await coordinator.write(async (transaction) => {
      // Revocable keys belong to another tenant so both stay within the 1200/min tenant reservation.
      for (const [id, presented, tenant] of [
        [keyId, key, "quiet"],
        ...revocable.map((item) => [item.id, item.key, "noisy"]),
      ]) {
        await transaction
          .forModule("partner-api-keys")
          .write(
            "partner_api_keys",
            "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,$3,'Resilience',$2,'operator:test')",
            [id, hashPartnerApiKey(presented), tenant],
          );
      }
    });

    const upstream = createHttpServer((_, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ fixture: true }));
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const nativeEnvironment = {
      ...RUNTIME_TEST_ENVIRONMENT,
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: String(target),
      DATABASE_REPLICA_URL: localReplicaUrl(String(target)),
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(String(target), t),
      BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
      BLAST_BACKEND_INGRESS_MODE: "direct",
      BLAST_PARTNER_CAPACITY_CONFIG: JSON.stringify(syntheticCapacity),
      BLAST_QUOTA_REDIS_URL: redisUrl,
      BLAST_REDIS_NAMESPACE: namespace + ":native",
      RATE_LIMIT_SUBJECT_PEPPER: pepper,
      BLAST_BACKEND_GATEWAY_SECRET: "synthetic-native-gateway-01234567890123456789",
      BLAST_INFRA_ORIGIN: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      BLAST_INFRA_API_KEY: "synthetic-native-infra-key-01234567890123456789",
      NEXT_PUBLIC_SITE_URL: "https://frontend.test",
      BLAST_DEPLOYMENT_TARGET: "preview",
      BLAST_DEPLOYMENT_BRANCH: "recognition-resilience-fixture",
      MISSION_CONTROL_METRICS: "on",
    };
    const childNamespace = quotaNamespace(
      nativeEnvironment.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(nativeEnvironment),
    );
    const nativeStore = new PartnerRecognitionStore(redis, childNamespace, pepper, capacity);
    const { logs, origins } = await launchReplicas(nativeEnvironment, children);
    const read = async (
      replica: number,
      presented: string,
      browser?: "get" | "preflight",
    ): Promise<Sample> => {
      const started = performance.now();
      const headers: Record<string, string> =
        browser === "preflight"
          ? {
              origin: "https://quiet.example",
              "access-control-request-method": "GET",
              "access-control-request-headers": "x-blast-partner-key",
            }
          : {
              "x-blast-partner-key": presented,
              ...(browser ? { origin: "https://quiet.example" } : {}),
            };
      try {
        const answer = await fetch(origins[replica] + "/api/v1/market/status", {
          method: browser === "preflight" ? "OPTIONS" : "GET",
          headers,
          signal: AbortSignal.timeout(5_000),
        });
        const body = await answer.text();
        // A 429 is labelled by layer: recognition refusals precede any grant.
        const layer =
          answer.status === 429
            ? body.includes("Partner request limit reached.")
              ? ":recognition"
              : ":commercial"
            : "";
        const code =
          answer.status === 200
            ? undefined
            : (/"code":"([a-z_]{1,64})"/.exec(body)?.[1] ?? "none") + layer;
        return {
          at: started,
          status: answer.status,
          ms: performance.now() - started,
          code,
        };
      } catch {
        return { at: started, status: 0, ms: performance.now() - started };
      }
    };
    // Paced load: `perSecond` sequential requests per replica, never above commercial windows.
    const drive = (
      presented: string,
      perSecond: number,
      until: () => boolean,
      browser?: "get" | "preflight",
    ) =>
      Promise.all(
        [0, 1].map(async (replica) => {
          const samples: Sample[] = [];
          while (!until()) {
            const sample = await read(replica, presented, browser);
            samples.push(sample);
            await pause(Math.max(0, 1000 / perSecond - sample.ms));
          }
          return samples;
        }),
      );
    const recovery = (replica: number, from: number) => {
      const lines = logs[replica]
        .slice(from)
        .split("\n")
        .filter((line) => line.includes('"metric":"partner.recognition_recovery"'));
      return {
        success: lines.filter((line) => line.includes('"outcome":"success"')).length,
        failure: lines.filter((line) => line.includes('"outcome":"failure"')).length,
        preserved: lines.filter((line) => line.includes('"preserved":true')).length,
      };
    };
    for (let attempt = 0; attempt < 100; attempt++) {
      const ready = await Promise.all([0, 1].map((replica) => read(replica, key)));
      if (ready.every((sample) => sample.status === 200)) {
        break;
      }
      await pause(50);
    }

    await t.test(
      "a revocation trim deferred by a held advisory lock keeps both replicas serving",
      async () => {
        const holderPool = new Pool({
          connectionString: String(target),
          max: 1,
        });
        const holder = await holderPool.connect();
        try {
          const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0].pid;
          let held = false;
          let revoked: (typeof revocable)[number] | undefined;
          for (const candidate of revocable) {
            let queued!: () => void;
            const lockQueued = new Promise<void>((resolve) => {
              queued = resolve;
            });
            let acquiring: Promise<unknown> | undefined;
            // Queue the holder behind the revoking write so no tick can trim in between.
            await nativeStore.marker(nativeStore.epoch());
            await coordinatorFor(childNamespace).write(async (transaction) => {
              await transaction
                .forModule("partner-api-keys")
                .write(
                  "partner_api_keys",
                  "UPDATE partner_api_keys SET revoked_at=now(),revoked_by='operator:test' WHERE id=$1",
                  [candidate.id],
                );
              // The same deferred trim also removes the paid tenant's only browser origin.
              await transaction
                .forModule("partner-api-keys")
                .write(
                  "partner_api_partners",
                  "UPDATE partner_api_partners SET origins='{}'::text[],updated_by='operator:test' WHERE id='quiet'",
                );
              acquiring = holder.query("SELECT pg_advisory_lock($1::bigint)", [
                PARTNER_RECOGNITION_LOCK,
              ]);
              for (let wait = 0; wait < 200; wait++) {
                const waiting = await admin.query(
                  "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pid=$1",
                  [holderPid],
                );
                if (waiting.rows[0].n === 1) {
                  break;
                }
                await pause(10);
              }
              queued();
            });
            await lockQueued;
            await acquiring;
            const marker = await nativeStore.marker(nativeStore.epoch());
            revoked = candidate;
            if (marker?.needsTrim) {
              held = true;
              break;
            }
            await holder.query("SELECT pg_advisory_unlock($1::bigint)", [PARTNER_RECOGNITION_LOCK]);
          }
          assert.ok(
            held && revoked,
            "A committed revocation must leave needsTrim while the lock is held.",
          );
          const from = logs.map((log) => log.length);
          const holdMs = 6_500;
          const started = performance.now();
          const waiters: number[] = [];
          const sampling = (async () => {
            while (performance.now() - started < holdMs) {
              waiters.push(
                (
                  await admin.query(
                    "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted",
                  )
                ).rows[0].n,
              );
              await pause(250);
            }
          })();
          const holding = () => performance.now() - started >= holdMs;
          const [paid, revokedReads, removedOrigin, preflights] = await Promise.all([
            drive(key, 4, holding),
            drive(revoked!.key, 1, holding),
            drive(key, 1, holding, "get"),
            drive(key, 1, holding, "preflight"),
            sampling,
          ]);
          await holder.query("SELECT pg_advisory_unlock($1::bigint)", [PARTNER_RECOGNITION_LOCK]);
          const released = performance.now();
          let trimmedMs: number | null = null;
          while (performance.now() - released < 10_000) {
            if ((await nativeStore.marker(nativeStore.epoch()))?.needsTrim === false) {
              trimmedMs = Math.round(performance.now() - released);
              break;
            }
            await pause(50);
          }
          const replicas = [0, 1].map((replica) => ({
            statuses: statuses(paid[replica]),
            latencyMs: percentiles(
              paid[replica].filter((sample) => sample.status === 200).map((sample) => sample.ms),
            ),
            revokedStatuses: statuses(revokedReads[replica]),
            removedOriginGet: statuses(removedOrigin[replica]),
            // Documented residual: the stale origin set still answers preflights until the trim.
            removedOriginPreflight: statuses(preflights[replica]),
            recovery: recovery(replica, from[replica]),
          }));
          await record("lock-held-needs-trim", {
            holdMs,
            waitersMax: Math.max(...waiters),
            trimmedAfterReleaseMs: trimmedMs,
            replicas,
          });
          for (const replica of replicas) {
            assert.deepEqual(
              Object.keys(replica.statuses),
              ["200"],
              "Contention must not withdraw readiness; paced load stays below commercial windows.",
            );
            assert.deepEqual(
              Object.keys(replica.revokedStatuses),
              ["401:partner_key_invalid"],
              "A revoked key stays grantless while its trim is deferred.",
            );
            assert.deepEqual(
              Object.keys(replica.removedOriginGet),
              ["403:partner_origin_forbidden"],
              "A removed origin never reads, even before the trim.",
            );
            assert.ok(replica.recovery.failure > 0, "Each replica actually met the held lock.");
            assert.ok(replica.recovery.preserved > 0, "The contended tick preserved readiness.");
          }
          assert.ok(trimmedMs !== null, "Trim converges after the lock is released.");
        } finally {
          holder.release();
          await holderPool.end();
        }
      },
    );

    await t.test(
      "a paused own Redis fails closed and both replicas recover promptly after unpause",
      async () => {
        assert.ok(
          redisContainer?.startsWith("blast-v2-disposable-redis-"),
          "Only the wrapper-owned container may be paused.",
        );
        const dayCounters = async () => {
          const keys = (
            (await redis.execute(["KEYS", `${childNamespace}:*partner_read:*:86400`])) as string[]
          ).sort();
          return Promise.all(
            keys.map(async (name) =>
              Number(String(await redis.execute(["GET", name])).split(":")[1]),
            ),
          );
        };
        const before = await dayCounters();
        assert.equal(before.length, 1, "Only the paced paid key spends commercial windows.");
        let phase: "steady" | "paused" | "recovering" | "done" = "steady";
        let unpausedAt = 0;
        // launchpad_market_status allows 120/min per key: both scenarios together stay below it.
        const load = drive(key, 2, () => phase === "done");
        await pause(2_000);
        phase = "paused";
        const pausedAt = performance.now();
        execFileSync("docker", ["pause", redisContainer!]);
        try {
          await pause(3_000);
        } finally {
          execFileSync("docker", ["unpause", redisContainer!]);
          unpausedAt = performance.now();
          phase = "recovering";
        }
        await pause(8_000);
        phase = "done";
        const samples = await load;
        const after = await dayCounters();
        const replicas = samples.map((replica) => {
          const afterUnpause = replica.filter((sample) => sample.at >= unpausedAt);
          const firstOk = afterUnpause.find((sample) => sample.status === 200);
          let steadyAt: number | null = null;
          for (let index = 0; index + 5 <= afterUnpause.length; index++) {
            if (afterUnpause.slice(index, index + 5).every((sample) => sample.status === 200)) {
              steadyAt = Math.round(afterUnpause[index].at - unpausedAt);
              break;
            }
          }
          return {
            sent: replica.length,
            before: {
              statuses: statuses(replica.filter((s) => s.at < pausedAt)),
              latencyMs: percentiles(
                replica.filter((s) => s.at < pausedAt && s.status === 200).map((s) => s.ms),
              ),
            },
            paused: statuses(replica.filter((s) => s.at >= pausedAt && s.at < unpausedAt)),
            firstOkAfterUnpauseMs: firstOk
              ? Math.round(firstOk.at + firstOk.ms - unpausedAt)
              : null,
            steadyAfterUnpauseMs: steadyAt,
            recovered: {
              statuses: statuses(afterUnpause),
              latencyMs: percentiles(afterUnpause.filter((s) => s.status === 200).map((s) => s.ms)),
            },
          };
        });
        const sent = replicas.reduce((sum, replica) => sum + replica.sent, 0);
        await record("redis-pause", {
          pauseMs: Math.round(unpausedAt - pausedAt),
          counterBefore: before,
          counterAfter: after,
          sent,
          replicas,
        });
        assert.ok(
          before[0] <= after[0] && after[0] <= before[0] + sent,
          "Commercial counters are neither reset nor over-spent.",
        );
        for (const replica of replicas) {
          assert.ok(
            replica.firstOkAfterUnpauseMs !== null && replica.firstOkAfterUnpauseMs <= 3_000,
            "Recovery begins within 3 s of unpause.",
          );
          assert.ok(replica.steadyAfterUnpauseMs !== null, "Serving returns to steady 200s.");
          assert.equal(
            Object.keys(replica.recovered.statuses).some((label) => label.startsWith("429")),
            false,
            "Paced load stays below commercial windows.",
          );
        }
      },
    );

    await t.test(
      "a saturated shared primary pool does not withdraw readiness from a verified map",
      async () => {
        const saturated = new Pool({
          connectionString: String(target),
          max: 2,
          connectionTimeoutMillis: 300,
        });
        try {
          const replica = new PartnerRecognition(saturated, nativeStore);
          await replica.reconcile();
          assert.equal(replica.ready(), true);
          const digest = nativeStore.digest(hashPartnerApiKey(key));
          const holders = [
            saturated.query("SELECT pg_sleep(3)"),
            saturated.query("SELECT pg_sleep(3)"),
          ];
          await pause(100);
          const ticks: { ready: boolean; known: string; ms: number }[] = [];
          for (let tick = 0; tick < 3; tick++) {
            const started = performance.now();
            await replica.reconcile().catch(() => undefined);
            const ms = Math.round(performance.now() - started);
            const known = await replica.classify({ digest, ip: "198.18.0.9" }).then(
              (decision) => decision.kind,
              () => "refused",
            );
            ticks.push({ ready: replica.ready(), known, ms });
          }
          await Promise.all(holders);
          await replica.reconcile();
          await record("pool-saturation", {
            ticks,
            readyAfterRelease: replica.ready(),
          });
          assert.deepEqual(
            ticks.map((tick) => [tick.ready, tick.known]),
            [
              [true, "known"],
              [true, "known"],
              [true, "known"],
            ],
          );
        } finally {
          await saturated.end();
        }
      },
    );

    function coordinatorFor(selected: string): PartnerRecognition {
      return new PartnerRecognition(pool, selected === childNamespace ? nativeStore : store);
    }
  },
);

/** A fresh disposable database carrying only the partner recognition migrations. */
async function recognitionDatabase(admin: Pool) {
  const dbName = "resilience_" + randomUUID().replaceAll("-", "");
  await admin.query(`CREATE DATABASE ${dbName}`);
  const target = new URL(databaseUrl!);
  target.pathname = "/" + dbName;
  const pool = new Pool({ connectionString: String(target), max: 2 });
  const drop = async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  };
  await pool.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='blast_web') THEN CREATE ROLE blast_web NOLOGIN; END IF; END $$",
  );
  for (const migration of [
    "0124_partner_api_keys",
    "0127_partner_key_tiers",
    "0129_partner_admin_deletion",
    "0131_partner_recognition_marker",
    "0132_partner_verifier_role",
  ]) {
    await pool.query(
      await readFile(
        new URL(
          `../../../packages/core/src/modules/database/migrations/${migration}.up.sql`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  return { target, pool, drop };
}

/** Start counter-exact checks early in a Redis minute so no window rolls over mid-check. */
async function freshMinute(redis: ReturnType<typeof createRedisConnection>): Promise<void> {
  const clock = (await redis.execute(["TIME"])) as string[];
  const left = 60 - (Number(clock[0]) % 60);
  if (left < 20) {
    await pause(left * 1000 + 50);
  }
}

const insertKey =
  (id: string, presented: string, tenant: string, minute?: number) =>
  (transaction: TransactionContext) =>
    transaction
      .forModule("partner-api-keys")
      .write(
        "partner_api_keys",
        minute
          ? "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by,tier,requests_per_minute,requests_per_day) VALUES ($1,$3,'Resilience',$2,'operator:test','custom',$4,$4)"
          : "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,$3,'Resilience',$2,'operator:test')",
        minute
          ? [id, hashPartnerApiKey(presented), tenant, minute]
          : [id, hashPartnerApiKey(presented), tenant],
      );

test(
  "bounded preservation, fail-closed negatives, write phases, per-network preflight and 429 shapes",
  {
    skip: databaseUrl && redisUrl ? false : "Disposable primary and Redis required",
  },
  async (t) => {
    // Explicit cleanup: Bun's node:test shim may run parent after-hooks before a late subtest.
    const admin = new Pool({ connectionString: databaseUrl!, max: 1 });
    const { target, pool, drop } = await recognitionDatabase(admin);
    const redis = createRedisConnection(redisUrl!, "quota");
    try {
      const capacity = partnerCapacity(
        JSON.stringify({
          ...syntheticCapacity,
          tenants: [
            ...syntheticCapacity.tenants,
            {
              id: "capped",
              requestsPerMinute: 2,
              keyRequestsPerMinute: 2,
              maxInflight: 8,
              queueLimit: 4,
            },
          ],
        }),
      );
      const namespace = "test:" + randomUUID();
      const store = new PartnerRecognitionStore(redis, namespace, pepper, capacity);
      const coordinator = new PartnerRecognition(pool, store);
      await pool.query(
        "INSERT INTO partner_api_partners(id,origins,created_by,updated_by) VALUES ('quiet',ARRAY['https://quiet.example'],'operator:test','operator:test'),('capped',ARRAY[]::text[],'operator:test','operator:test')",
      );
      const key = generatePartnerApiKey();
      const capped = generatePartnerApiKey();
      await coordinator.reconcile();
      await coordinator.write(async (transaction) => {
        await insertKey(randomUUID(), key, "quiet")(transaction);
        await insertKey(randomUUID(), capped, "capped", 2)(transaction);
      });
      const digest = store.digest(hashPartnerApiKey(key));
      const known = () =>
        coordinator.classify({ digest, ip: "198.18.2.1" }).then(
          (decision) => decision.kind,
          () => "refused",
        );

      await t.test("preservation ends at its bound and recovery follows release", async () => {
        const saturated = new Pool({
          connectionString: String(target),
          max: 2,
          connectionTimeoutMillis: 300,
        });
        try {
          const bounded = new PartnerRecognition(saturated, store, {
            preserveMs: 1_500,
          });
          await bounded.reconcile();
          const verified = performance.now();
          const holders = [
            saturated.query("SELECT pg_sleep(4)"),
            saturated.query("SELECT pg_sleep(4)"),
          ];
          await pause(100);
          const ticks: { atMs: number; ready: boolean }[] = [];
          while (performance.now() - verified < 3_000) {
            await bounded.reconcile().catch(() => undefined);
            ticks.push({
              atMs: Math.round(performance.now() - verified),
              ready: bounded.ready(),
            });
            await pause(200);
          }
          await Promise.all(holders);
          await bounded.reconcile();
          await record("preservation-bound", {
            preserveMs: 1_500,
            ticks,
            readyAfterRelease: bounded.ready(),
          });
          assert.ok(
            ticks.some((tick) => tick.ready),
            "Preserved inside the bound.",
          );
          assert.ok(
            ticks.filter((tick) => tick.atMs > 1_900).every((tick) => !tick.ready),
            "Fails closed past the bound.",
          );
          assert.equal(bounded.ready(), true);
        } finally {
          await saturated.end();
        }
      });

      await t.test(
        "mismatches that are not a same-generation superset fail closed within one contended tick",
        async () => {
          const holderPool = new Pool({
            connectionString: String(target),
            max: 1,
          });
          const holder = await holderPool.connect();
          const metadata = store.keys[0];
          const original = String(await redis.execute(["GET", metadata]));
          const outcomes: Record<string, boolean> = {};
          try {
            await holder.query("SELECT pg_advisory_lock($1::bigint)", [PARTNER_RECOGNITION_LOCK]);
            const parsed = JSON.parse(original) as {
              generation: string;
              revision: string;
            };
            for (const [name, value] of [
              [
                "other-generation",
                JSON.stringify({
                  ...JSON.parse(original),
                  generation: randomUUID(),
                }),
              ],
              [
                "redis-behind",
                JSON.stringify({
                  ...JSON.parse(original),
                  revision: String(BigInt(parsed.revision) - 1n),
                }),
              ],
              ["malformed-metadata", "not-json"],
            ] as const) {
              await redis.execute(["SET", metadata, original]);
              const replica = new PartnerRecognition(pool, store);
              await replica.reconcile();
              await redis.execute(["SET", metadata, value]);
              await replica.reconcile().catch(() => undefined);
              outcomes[name] = replica.ready();
            }
          } finally {
            await holder
              .query("SELECT pg_advisory_unlock($1::bigint)", [PARTNER_RECOGNITION_LOCK])
              .catch(() => undefined);
            holder.release();
            await holderPool.end();
            await redis.execute(["SET", metadata, original]);
          }
          // A GENERATION refusal from this attempt's own publish is a store error.
          const replica = new PartnerRecognition(pool, store);
          await replica.reconcile();
          await coordinator.write((transaction) =>
            transaction
              .forModule("partner-api-keys")
              .write(
                "partner_api_keys",
                "UPDATE partner_api_keys SET label='Trim pending' WHERE partner_id='quiet'",
              ),
          );
          const publish = t.mock.method(store, "publish", async () => {
            throw new Error("Redis command refused.");
          });
          try {
            await replica.reconcile().catch(() => undefined);
            outcomes["injected-generation"] = replica.ready();
          } finally {
            publish.mock.restore();
          }
          await record("fail-closed-negatives", {
            readyAfterOneTick: outcomes,
          });
          assert.deepEqual(outcomes, {
            "other-generation": false,
            "redis-behind": false,
            "malformed-metadata": false,
            "injected-generation": false,
          });
          await coordinator.reconcile().catch(() => coordinator.reconcile());
          assert.equal(await known(), "known");
        },
      );

      await t.test(
        "operator errors keep serving; a post-publish failure keeps serving and reconverges",
        async () => {
          if (!coordinator.ready()) {
            await coordinator.reconcile();
          }
          const before = await store.marker(store.epoch());
          await assert.rejects(
            coordinator.write((transaction) =>
              transaction
                .forModule("partner-api-keys")
                .write(
                  "partner_api_partners",
                  "INSERT INTO partner_api_partners(id,origins,created_by,updated_by) VALUES ('quiet','{}','operator:test','operator:test')",
                ),
            ),
            (error: unknown) => (error as { code?: string }).code === "23505",
          );
          assert.equal(coordinator.ready(), true);
          assert.deepEqual(
            await store.marker(store.epoch()),
            before,
            "Pre-publish refusal leaves Redis untouched.",
          );
          await pool.query(`CREATE FUNCTION resilience_fail_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic post-publish failure'; END $$;
        CREATE TRIGGER resilience_fail_marker BEFORE UPDATE ON partner_api_recognition FOR EACH ROW EXECUTE FUNCTION resilience_fail_marker()`);
          const candidate = generatePartnerApiKey();
          try {
            await assert.rejects(coordinator.write(insertKey(randomUUID(), candidate, "quiet")));
          } finally {
            await pool.query(
              "DROP TRIGGER resilience_fail_marker ON partner_api_recognition; DROP FUNCTION resilience_fail_marker()",
            );
          }
          assert.equal(
            coordinator.ready(),
            true,
            "Redis holds a same-generation superset: keep serving.",
          );
          const ahead = await store.marker(store.epoch());
          assert.equal(ahead?.generation, before?.generation);
          assert.equal(BigInt(ahead!.revision), BigInt(before!.revision) + 1n);
          const started = performance.now();
          const stop = coordinator.startRecovery();
          const kinds: string[] = [];
          let convergedMs: number | null = null;
          try {
            while (performance.now() - started < 8_000) {
              kinds.push(await known());
              const marker = await store.marker(store.epoch());
              if (marker && marker.generation !== before?.generation) {
                convergedMs = Math.round(performance.now() - started);
                break;
              }
              await pause(20);
            }
          } finally {
            await stop();
          }
          const rolledBack = await coordinator.classify({
            digest: store.digest(hashPartnerApiKey(candidate)),
            ip: "198.18.2.1",
          });
          await record("post-publish-failure", {
            convergedMs,
            samples: kinds.length,
            refused: kinds.filter((kind) => kind !== "known").length,
          });
          assert.ok(
            convergedMs !== null && convergedMs < 2_000,
            "The nudged recovery rebuilds promptly.",
          );
          assert.deepEqual(
            [...new Set(kinds)],
            ["known"],
            "Existing keys keep serving throughout.",
          );
          assert.equal(
            rolledBack.kind,
            "unknown",
            "The rolled-back candidate is gone after the rebuild.",
          );
        },
      );

      await t.test(
        "one client network cannot spend the shared preflight reserve; IPv6 counts per /64",
        async () => {
          if (!coordinator.ready()) {
            await coordinator.reconcile();
          }
          await freshMinute(redis);
          const origin = (ip: string) =>
            coordinator.classify({ origin: "https://quiet.example", ip });
          const kinds = async (ips: string[]) => {
            const out: string[] = [];
            for (const ip of ips) {
              const decision = await origin(ip);
              out.push(decision.limit ?? decision.kind);
            }
            return out;
          };
          const v4 = await kinds(Array.from({ length: 26 }, () => "198.18.3.1"));
          assert.deepEqual(v4.slice(0, 25), Array(25).fill("origin"));
          assert.equal(v4[25], "preflight-ip");
          assert.equal((await origin("198.18.3.2")).kind, "origin");
          const v6 = await kinds(
            Array.from({ length: 26 }, (_, index) => `2001:db8:5:6::${(index + 1).toString(16)}`),
          );
          assert.deepEqual(v6.slice(0, 25), Array(25).fill("origin"));
          assert.equal(v6[25], "preflight-ip", "Rotating inside one /64 is one network.");
          assert.equal((await origin("2001:db8:5:7::1")).kind, "origin");
          const shared = `${namespace}:{partner-quota}:recognition-admission:preflight`;
          assert.match(
            String(await redis.execute(["GET", shared])),
            /^\d+:52$/,
            "Only admitted preflights spend the shared reserve, in its unchanged format.",
          );
          await record("preflight-per-network", {
            perNetworkLimit: 25,
            shared: String(await redis.execute(["GET", shared])),
          });
        },
      );

      await t.test(
        "recognized key cap and unknown-key refusals share one opaque 429 shape",
        async () => {
          if (!coordinator.ready()) {
            await coordinator.reconcile();
          }
          await freshMinute(redis);
          const api = createBackendApi({
            namespace,
            subjectPepper: pepper,
            redis,
            recognition: coordinator,
            keys: createPartnerKeyReader(() => pool),
            handlers: () => assert.fail("Refusals never build handlers"),
          });
          const request = (presented: string) =>
            new Request("https://backend.test/api/v1/market/status", {
              headers: {
                "x-blast-partner-key": presented,
                "x-forwarded-for": "198.18.4.1",
                origin: "https://quiet.example",
              },
            });
          for (let admitted = 0; admitted < 2; admitted++) {
            const prepared = await api.preparePartner(request(capped), testClient("198.18.4.1"));
            assert.ok(prepared && !prepared.response, "Within the per-key operational cap");
            prepared!.release!();
          }
          const keyCap = (await api.preparePartner(request(capped), testClient("198.18.4.1")))!
            .response!;
          let unknown: Response | undefined;
          for (let attempt = 0; attempt < 120 && !unknown; attempt++) {
            const answer = (await api.preparePartner(
              request(generatePartnerApiKey()),
              testClient("198.18.4.1"),
            ))!.response!;
            if (answer.status === 429) {
              unknown = answer;
            }
          }
          assert.ok(unknown, "Shared unknown admission exhausts.");
          const shape = async (response: Response) => {
            const body = JSON.parse(await response.text(), (name, value) =>
              name === "requestId" ? undefined : value,
            ) as unknown;
            const headers = [...response.headers.keys()]
              .filter((name) => name !== "date" && !name.includes("request-id"))
              .sort();
            return { status: response.status, body, headers };
          };
          const [capShape, unknownShape] = [
            await shape(keyCap.clone()),
            await shape(unknown!.clone()),
          ];
          await record("refusal-shapes", {
            keyCap: capShape,
            unknown: unknownShape,
          });
          assert.deepEqual(capShape, unknownShape);
          assert.equal(capShape.status, 429);
          for (const response of [keyCap, unknown!]) {
            const retry = Number(response.headers.get("retry-after"));
            assert.ok(retry >= 1 && retry <= 60);
            assert.equal(response.headers.get("access-control-allow-origin"), null);
          }
        },
      );

      await t.test(
        "with a full shared reserve the caller's own network limit is reported first",
        async () => {
          const tight = partnerCapacity(
            JSON.stringify({
              ...capacity,
              reserves: { ...capacity.reserves, preflight: 30 },
              preflightPerIp: 10,
            }),
          );
          const tightStore = new PartnerRecognitionStore(
            redis,
            namespace + ":tight",
            pepper,
            tight,
          );
          const tightCoordinator = new PartnerRecognition(pool, tightStore);
          await tightCoordinator.reconcile();
          await freshMinute(redis);
          const origin = (ip: string) =>
            tightCoordinator.classify({ origin: "https://quiet.example", ip });
          for (const ip of ["198.18.5.1", "198.18.5.2", "198.18.5.3"]) {
            for (let index = 0; index < 10; index++) {
              assert.equal((await origin(ip)).kind, "origin");
            }
          }
          assert.equal(
            (await origin("198.18.5.4")).limit,
            "preflight",
            "A fresh network meets the exhausted shared reserve (503).",
          );
          assert.equal(
            (await origin("198.18.5.1")).limit,
            "preflight-ip",
            "A network over its own limit is told so (429), deterministically.",
          );
        },
      );
    } finally {
      redis.close();
      await drop();
      await admin.end();
    }
  },
);
