import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import {
  DEFAULT_RATE_POLICIES,
  rateLimitSubjectKey,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { Pool } from "pg";
import { createRedisConnection, RedisEpochChanged, RedisBusy } from "@blast/core/lib/redis.ts";
import {
  GatewayReplayError,
  RedisRateLimitEnforcer,
  OperationalRateLimited,
} from "@blast/core/lib/web-security/redis-rate-limits.ts";
import {
  PartnerRecognitionStore,
  RecognitionUnavailable,
  RecognitionIntegrityError,
} from "@blast/server/modules/partner-api-keys/recognition-store.ts";
import { PartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import { partnerRecognitionNamespace } from "@blast/server/modules/partner-api-keys/recognition-namespace.ts";
import { partnerCapacity } from "@blast/server/modules/partner-api-keys/capacity.ts";
import {
  generatePartnerApiKey,
  hashPartnerApiKey,
} from "@blast/server/modules/partner-api-keys/contracts.ts";
import { createPartnerKeyReader } from "@blast/server/modules/partner-api-keys/repository.ts";
import { syntheticCapacity } from "@blast/server/modules/partner-api-keys/capacity.test.ts";
import { createBackendApi } from "../src/app/api/routing.ts";
import { testClient } from "../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import {
  localReplicaUrl,
  RUNTIME_TEST_ENVIRONMENT,
} from "../../../packages/server/test/fixtures/config/runtime-config.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const redisUrl = process.env.BLAST_TEST_REDIS_URL;
const pepper = "synthetic-recognition-pepper-01234567890123456789";

test(
  "physical recognition serializes primary publication, preserves identities and never authenticates from Redis",
  {
    skip: databaseUrl && redisUrl ? false : "Disposable primary and Redis required",
  },
  async (t) => {
    assert.ok(databaseUrl && redisUrl);
    for (const url of [databaseUrl, redisUrl]) {
      assert.equal(new URL(url).hostname, "127.0.0.1");
    }
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    const dbName = "recognition_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE DATABASE ${dbName}`);
    const target = new URL(databaseUrl);
    target.pathname = "/" + dbName;
    const pool = new Pool({ connectionString: String(target), max: 2 });
    const redis = createRedisConnection(redisUrl, "quota");
    const environment = {
      BLAST_REDIS_NAMESPACE: "test:" + randomUUID(),
      BLAST_DEPLOYMENT_TARGET: "develop",
      BLAST_DEPLOYMENT_BRANCH: "develop",
    };
    const namespace = partnerRecognitionNamespace(
      undefined,
      quotaNamespace(environment.BLAST_REDIS_NAMESPACE, deploymentIdentity(environment)),
    );
    const capacity = partnerCapacity(JSON.stringify(syntheticCapacity));
    const store = new PartnerRecognitionStore(redis, namespace, pepper, capacity);
    const coordinator = new PartnerRecognition(pool, store);
    const reader = createPartnerKeyReader(() => pool);
    const privateBefore: unknown[] = [];
    t.after(async () => {
      redis.close();
      await pool.end();
      await admin.query(`DROP DATABASE ${dbName}`);
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
    await pool.query("CREATE TABLE retained_accounts (id text PRIMARY KEY, session text NOT NULL)");
    await pool.query(
      "INSERT INTO retained_accounts VALUES ('existing-account','existing-session')",
    );
    privateBefore.push(...(await pool.query("SELECT * FROM retained_accounts")).rows);
    const quota = new RedisRateLimitEnforcer({
      redis,
      namespace,
      subjectPepper: pepper,
    });
    // Preserve exact minute/day values throughout this real-clock exhaustion workload.
    const redisClock = (await redis.execute(["TIME"])) as string[];
    const secondsLeft = 60 - (Number(redisClock[0]) % 60);
    if (secondsLeft < 40) {
      await pause(secondsLeft * 1000 + 50);
    }
    await quota.consume("partner_read", { apiKeyId: "existing-counter" });
    const quotaKeys = (await redis.execute(["KEYS", `${namespace}:*partner_read:*`])) as string[];
    const usageBefore = await Promise.all(quotaKeys.map((key) => redis.execute(["GET", key])));
    await pool.query(
      "INSERT INTO partner_api_partners(id,origins,created_by,updated_by) VALUES ('quiet',ARRAY['https://quiet.example'],'operator:test','operator:test'),('noisy',ARRAY[]::text[],'operator:test','operator:test')",
    );
    const key = generatePartnerApiKey(),
      keyId = randomUUID();
    await pool.query(
      "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,'quiet','Existing',$2,'operator:test')",
      [keyId, hashPartnerApiKey(key)],
    );
    await coordinator.reconcile();
    const digest = store.digest(hashPartnerApiKey(key));
    assert.equal((await coordinator.classify({ digest, ip: "198.18.0.1" })).kind, "known");
    assert.equal(
      (await coordinator.classify({ digest: "f".repeat(64), ip: "198.18.0.1" })).kind,
      "unknown",
    );
    assert.equal((await reader.verify(key))?.keyId, keyId);

    await t.test("different gateway branches share one stable recognition marker", async () => {
      const preview = {
        ...environment,
        BLAST_DEPLOYMENT_TARGET: "preview",
        BLAST_DEPLOYMENT_BRANCH: "codex/pnl-leaderboard",
      };
      const previewNamespace = quotaNamespace(
        preview.BLAST_REDIS_NAMESPACE,
        deploymentIdentity(preview),
      );
      const previewStore = new PartnerRecognitionStore(
        redis,
        partnerRecognitionNamespace(namespace, previewNamespace),
        pepper,
        capacity,
      );
      const second = new PartnerRecognition(pool, previewStore);
      const marker = (
        await pool.query(
          "SELECT generation, revision FROM partner_api_recognition WHERE singleton = true",
        )
      ).rows;
      for (let pass = 0; pass < 3; pass++) {
        await second.reconcile();
        await coordinator.reconcile();
        assert.equal((await second.classify({ digest, ip: "198.18.0.20" })).kind, "known");
        assert.deepEqual(
          (
            await pool.query(
              "SELECT generation, revision FROM partner_api_recognition WHERE singleton = true",
            )
          ).rows,
          marker,
        );
      }
      const previewQuota = new RedisRateLimitEnforcer({
        redis,
        namespace: previewNamespace,
        subjectPepper: pepper,
      });
      await previewQuota.consume("partner_read", {
        apiKeyId: "preview-only-counter",
      });
      assert.notEqual(previewNamespace, namespace);
      assert.equal(
        ((await redis.execute(["KEYS", `${previewNamespace}:*partner_read:*`])) as string[]).length,
        quotaKeys.length,
      );
      assert.deepEqual(
        await Promise.all(quotaKeys.map((key) => redis.execute(["GET", key]))),
        usageBefore,
      );
      const nonce = "n".repeat(32);
      await quota.claimGatewayNonce(nonce);
      await previewQuota.claimGatewayNonce(nonce);
      await assert.rejects(quota.claimGatewayNonce(nonce), GatewayReplayError);
      await assert.rejects(previewQuota.claimGatewayNonce(nonce), GatewayReplayError);
      // Exercise the real authenticated request path, including shared operational admission.
      const replicas = [
        [second, previewNamespace],
        [coordinator, namespace],
      ] as const;
      for (const [recognition, requestNamespace] of replicas) {
        const read = async () => Response.json({ ok: true });
        const api = createBackendApi({
          namespace: requestNamespace,
          subjectPepper: pepper,
          redis,
          recognition,
          keys: reader,
          handlers: () => ({
            defillama: read,
            daily_stats: read,
            presales: read,
            featured: read,
            presale: read,
            prices: read,
            discovery: read,
            search: read,
            market: read,
            wallet_launches: read,
            presale_proof: read,
            presale_allowlist_csv: read,
            coin_metadata: read,
          }),
        });
        const request = () =>
          new Request("https://backend.test/api/v1/market/status", {
            headers: { "x-blast-partner-key": key, "x-forwarded-for": "198.18.0.20" },
          });
        const gateway = {
          ip: "198.18.0.20",
          namespace: requestNamespace,
          nonce: "p".repeat(32),
        };
        const prepared = await api.preparePartner(request(), testClient(gateway.ip), gateway);
        assert.ok(prepared?.handle);
        try {
          assert.equal((await prepared.handle()).status, 200);
        } finally {
          prepared.release();
        }
        assert.equal(
          (await api.preparePartner(request(), testClient(gateway.ip), gateway))?.response?.status,
          403,
        );
      }
    });

    await t.test(
      "matched primary marker avoids full key scan, epoch guard refuses reconnect before command",
      async () => {
        const second = new PartnerRecognition(pool, store);
        const spy = t.mock.method(store, "digest", () => {
          assert.fail("matched marker must not scan registry rows");
        });
        try {
          await second.reconcile();
        } finally {
          spy.mock.restore();
        }
        const epoch = redis.connectionEpoch();
        redis.close();
        await assert.rejects(
          redis.executeAtEpoch(["SET", namespace + ":must-not-exist", "1"], epoch),
          RedisEpochChanged,
        );
        assert.equal(
          redis.connectionEpoch(),
          epoch,
          "guard must not open a replacement connection",
        );
        await coordinator.reconcile();
        assert.ok(redis.connectionEpoch() > epoch);
        assert.equal(await redis.execute(["GET", namespace + ":must-not-exist"]), null);
      },
    );

    await t.test(
      "local Redis busy preserves ready; integrity uncertainty invalidates and owned recovery rejoins",
      async () => {
        const busy = t.mock.method(store, "classify", async () => {
          throw new RedisBusy();
        });
        try {
          await assert.rejects(coordinator.classify({ digest, ip: "198.18.0.1" }), RedisBusy);
        } finally {
          busy.mock.restore();
        }
        assert.equal(coordinator.ready(), true);
        const busyMarker = await store.marker(store.epoch());
        const noRebuild = t.mock.method(store, "digest", () => {
          assert.fail("RedisBusy must not request a registry snapshot");
        });
        try {
          await coordinator.reconcile();
          assert.deepEqual(await store.marker(store.epoch()), busyMarker);
        } finally {
          noRebuild.mock.restore();
        }
        const uncertain = t.mock.method(store, "classify", async () => {
          throw new Error("Synthetic uncertain socket");
        });
        try {
          await assert.rejects(coordinator.classify({ digest, ip: "198.18.0.1" }));
        } finally {
          uncertain.mock.restore();
        }
        assert.equal(coordinator.ready(), false);
        const stop = coordinator.startRecovery();
        assert.equal(
          coordinator.startRecovery(),
          stop,
          "repeated start does not create another recovery task",
        );
        for (let attempt = 0; attempt < 100 && !coordinator.ready(); attempt++) {
          await pause(5);
        }
        await stop();
        assert.equal(coordinator.ready(), true);
        assert.ok(coordinator.recoveryStatus().successAt);
      },
    );

    await t.test(
      "existing identity corruption forces guarded periodic repair without changing commercial counters",
      async () => {
        const repairing = new PartnerRecognition(pool, store);
        await repairing.reconcile();
        const marker = await store.marker(store.epoch());
        const metadata = await redis.execute(["GET", store.keys[0]]);
        const count = await redis.execute(["HLEN", store.keys[1]]);
        const counters = await Promise.all(quotaKeys.map((key) => redis.execute(["GET", key])));
        await redis.execute(["HSET", store.keys[1], digest, "malformed-identity"]);
        assert.equal(await redis.execute(["GET", store.keys[0]]), metadata);
        assert.equal(await redis.execute(["HLEN", store.keys[1]]), count);
        assert.deepEqual(await store.marker(store.epoch()), marker);
        await assert.rejects(
          repairing.classify({ digest, ip: "198.18.0.1" }),
          RecognitionIntegrityError,
        );
        assert.equal(repairing.ready(), false);
        const stop = repairing.startRecovery();
        try {
          for (let attempt = 0; attempt < 200 && !repairing.ready(); attempt++) {
            await pause(5);
          }
          assert.equal(repairing.ready(), true);
          assert.equal((await repairing.classify({ digest, ip: "198.18.0.1" })).kind, "known");
          assert.notEqual((await store.marker(store.epoch()))!.generation, marker!.generation);
          assert.deepEqual(
            await Promise.all(quotaKeys.map((key) => redis.execute(["GET", key]))),
            counters,
          );
        } finally {
          await stop();
        }
      },
    );

    await t.test(
      "an invalidation during delayed reconciliation cannot be cleared by its stale success",
      async () => {
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const marker = await store.marker(store.epoch());
        const original = store.marker.bind(store);
        const delayed = t.mock.method(store, "marker", async (epoch: number) => {
          const value = await original(epoch);
          entered();
          await blocked;
          return value;
        });
        const running = coordinator.reconcile();
        try {
          await reached;
          coordinator.invalidate();
          release();
          await assert.rejects(running, RecognitionUnavailable);
        } finally {
          release();
          delayed.mock.restore();
        }
        assert.equal(coordinator.ready(), false);
        await coordinator.reconcile();
        assert.equal(coordinator.ready(), true);
        assert.notEqual((await store.marker(store.epoch()))!.generation, marker!.generation);
        assert.equal((await coordinator.classify({ digest, ip: "198.18.0.1" })).kind, "known");
      },
    );

    await t.test(
      "atomic operational refusal leaves commercial minute/day windows untouched",
      async () => {
        const operational = coordinator.responseWindow({
          tenant: "quiet",
          internal: false,
        });
        const now = Number(((await redis.execute(["TIME"])) as string[])[0]);
        const start = now - (now % 60);
        await redis.execute([
          "SET",
          operational.window.key,
          `${start}:${operational.window.limit}`,
          "EXAT",
          String(start + 60),
        ]);
        const keyId = randomUUID();
        const hash = createHmac("sha256", pepper)
          .update(
            rateLimitSubjectKey(DEFAULT_RATE_POLICIES.partner_read, {
              apiKeyId: keyId,
            }),
          )
          .digest("hex");
        const keys = [60, 86400].map(
          (seconds) => `${namespace}:{partner-quota}:partner_read:v1:${hash}:${seconds}`,
        );
        const before = await Promise.all(keys.map((key) => redis.execute(["GET", key])));
        await assert.rejects(
          quota.consumeAllWithOperational(
            ["partner_read"],
            { apiKeyId: keyId },
            operational.window,
            operational.redis,
          ),
          OperationalRateLimited,
        );
        assert.deepEqual(await Promise.all(keys.map((key) => redis.execute(["GET", key]))), before);
        assert.equal(
          await redis.execute(["GET", operational.window.key]),
          `${start}:${operational.window.limit}`,
        );
      },
    );

    await t.test(
      "malformed direct keys use no Redis/SQL while signed malformed requests still consume their nonce once",
      async () => {
        const api = createBackendApi({
          namespace,
          subjectPepper: pepper,
          redis,
          recognition: coordinator,
          keys: {
            verify: async () => assert.fail("Malformed key must not query primary"),
            allowsOrigin: async () => assert.fail("No Origin lookup"),
          },
          handlers: () => assert.fail("Malformed key must not build handlers"),
        });
        const request = () =>
          new Request("https://backend.test/api/v1/market/status", {
            headers: {
              "x-blast-partner-key": "malformed",
              "x-forwarded-for": "198.18.0.1",
            },
          });
        const execute = t.mock.method(redis, "execute", () =>
          assert.fail("Malformed direct key must not touch Redis"),
        );
        try {
          assert.equal(
            (await api.preparePartner(request(), testClient("198.18.0.1")))?.response?.status,
            401,
          );
        } finally {
          execute.mock.restore();
        }
        const gateway = { ip: "198.18.0.1", namespace, nonce: "m".repeat(32) };
        assert.equal(
          (await api.preparePartner(request(), testClient(gateway.ip), gateway))?.response?.status,
          401,
        );
        assert.equal(
          (await api.preparePartner(request(), testClient(gateway.ip), gateway))?.response?.status,
          403,
        );
        assert.equal(coordinator.ready(), true);
      },
    );

    await t.test(
      "new keys are recognized before commit acknowledgment on both replicas; unknown never becomes a grant",
      async () => {
        const issued = generatePartnerApiKey(),
          id = randomUUID();
        await coordinator.write(async (transaction) => {
          await transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,'quiet','New',$2,'operator:test')",
              [id, hashPartnerApiKey(issued)],
            );
        });
        const second = new PartnerRecognition(pool, store);
        await second.reconcile();
        assert.deepEqual(
          (
            await second.classify({
              digest: store.digest(hashPartnerApiKey(issued)),
              ip: "198.18.0.2",
            })
          ).identity,
          { tenant: "quiet", keyId: id },
        );
        assert.equal((await reader.verify(issued))?.keyId, id);
        await coordinator.write(async (transaction) => {
          await transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "UPDATE partner_api_keys SET revoked_at=now(), revoked_by='operator:test' WHERE id=$1",
              [id],
            );
        });
        assert.equal(
          (
            await coordinator.classify({
              digest: store.digest(hashPartnerApiKey(issued)),
              ip: "198.18.0.2",
            })
          ).kind,
          "known",
          "bounded false positive cannot authorize",
        );
        assert.equal(await reader.verify(issued), null);
      },
    );

    await t.test(
      "precommit removal and rollback retain every committed key and origin without granting the candidate",
      async () => {
        const original = store.publish.bind(store);
        let published!: () => void, finish!: () => void;
        const atPublication = new Promise<void>((resolve) => {
          published = resolve;
        });
        const resume = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const spy = t.mock.method(
          store,
          "publish",
          async (...args: Parameters<typeof store.publish>) => {
            await original(...args);
            published();
            await resume;
            throw new Error("Synthetic rollback after Redis publication");
          },
        );
        const pending = coordinator.write(async (transaction) => {
          await transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "UPDATE partner_api_keys SET revoked_at=now(),revoked_by='operator:test' WHERE id=$1",
              [keyId],
            );
          await transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_partners",
              "UPDATE partner_api_partners SET origins=ARRAY[]::text[] WHERE id='quiet'",
            );
        });
        try {
          await atPublication;
          assert.equal((await coordinator.classify({ digest, ip: "198.18.0.8" })).kind, "known");
          assert.equal(
            (
              await coordinator.classify({
                origin: "https://quiet.example",
                ip: "198.18.0.8",
              })
            ).kind,
            "origin",
          );
          assert.deepEqual(
            (await reader.verify(key))?.origins,
            ["https://quiet.example"],
            "fresh primary read still sees the committed key/origin",
          );
        } finally {
          finish();
          spy.mock.restore();
        }
        await assert.rejects(pending, /Synthetic rollback/);
        assert.equal((await reader.verify(key))?.keyId, keyId);
        await coordinator.reconcile();
        assert.equal((await coordinator.classify({ digest, ip: "198.18.0.8" })).kind, "known");
      },
    );

    await t.test(
      "delayed exact trim retains the valid ready superset and never erases later issuance",
      async () => {
        const issued = generatePartnerApiKey(),
          id = randomUUID();
        await coordinator.write((transaction) =>
          transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,'quiet','Trim race',$2,'operator:test')",
              [id, hashPartnerApiKey(issued)],
            ),
        );
        assert.equal(
          (await store.marker(store.epoch()))?.needsTrim,
          true,
          "union publication durably records unfinished trim",
        );
        const other = new PartnerRecognition(pool, store);
        const failedSnapshot = t.mock.method(store, "digest", () => {
          throw new Error("Synthetic snapshot failure");
        });
        try {
          await assert.rejects(other.reconcile(), /Synthetic snapshot failure/);
        } finally {
          failedSnapshot.mock.restore();
        }
        assert.equal(
          (await coordinator.classify({ digest, ip: "198.18.0.9" })).kind,
          "known",
          "failed snapshot preparation leaves another ready replica's map intact",
        );
        const actual = store.publish.bind(store);
        let release!: () => void, entered!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const atPublish = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const spy = t.mock.method(
          store,
          "publish",
          async (...args: Parameters<typeof store.publish>) => {
            entered();
            await held;
            return actual(...args);
          },
        );
        const trim = coordinator.reconcile();
        const later = generatePartnerApiKey(),
          laterId = randomUUID();
        let laterWrite: Promise<unknown> | undefined;
        try {
          await atPublish;
          assert.equal(
            (await coordinator.classify({ digest, ip: "198.18.0.9" })).kind,
            "known",
            "preparing an exact replacement does not enter building state",
          );
          laterWrite = other.write((transaction) =>
            transaction
              .forModule("partner-api-keys")
              .write(
                "partner_api_keys",
                "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,'quiet','Concurrent writer',$2,'operator:test')",
                [laterId, hashPartnerApiKey(later)],
              ),
          );
        } finally {
          release();
          spy.mock.restore();
        }
        await trim;
        await laterWrite;
        await coordinator.reconcile();
        assert.equal(
          (
            await coordinator.classify({
              digest: store.digest(hashPartnerApiKey(later)),
              ip: "198.18.0.9",
            })
          ).kind,
          "known",
          "later serialized issuance survives current-state trim",
        );
        assert.equal((await store.marker(store.epoch()))?.needsTrim, false);
        assert.equal(
          (
            await coordinator.classify({
              digest: store.digest(hashPartnerApiKey(issued)),
              ip: "198.18.0.9",
            })
          ).kind,
          "known",
        );
        await coordinator.write((transaction) =>
          transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "UPDATE partner_api_keys SET revoked_at=now(),revoked_by='operator:test' WHERE id=ANY($1::uuid[])",
              [[id, laterId]],
            ),
        );
        await coordinator.reconcile();
        assert.equal(
          (
            await coordinator.classify({
              digest: store.digest(hashPartnerApiKey(issued)),
              ip: "198.18.0.9",
            })
          ).kind,
          "unknown",
          "current-state locked trim prunes committed revocation",
        );
      },
    );

    await t.test(
      "Redis-ahead rollback preserves committed membership and marker mismatch rebuilds",
      async () => {
        const epoch = store.epoch();
        const primary = (
          await pool.query("SELECT generation::text,revision::text FROM partner_api_recognition")
        ).rows[0];
        const ahead = {
          ...primary,
          revision: String(BigInt(primary.revision) + 1n),
        };
        await store.publish(
          primary,
          ahead,
          {
            entries: [{ digest, tenant: "quiet", keyId, keyRequestsPerMinute: 600 }],
            origins: ["https://quiet.example"],
          },
          epoch,
        );
        const recovery = new PartnerRecognition(pool, store);
        await recovery.reconcile();
        assert.equal((await recovery.classify({ digest, ip: "198.18.0.3" })).kind, "known");
        assert.notEqual((await store.marker(store.epoch()))!.generation, primary.generation);
      },
    );

    await t.test(
      "atomic duplicate nonce, quota refusal, structural corruption and abandoned generation fail closed",
      async () => {
        const nonce = "a".repeat(32);
        const calls = await Promise.allSettled(
          Array.from({ length: 20 }, () =>
            coordinator.classify({ digest, ip: "198.18.0.4", nonce }),
          ),
        );
        assert.equal(calls.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(
          calls.filter(
            (result) => result.status === "rejected" && result.reason instanceof GatewayReplayError,
          ).length,
          19,
        );
        assert.equal(coordinator.ready(), true, "a replay does not invalidate the registry");
        const marker = (await store.marker(store.epoch()))!;
        await assert.rejects(
          store.publish(
            { ...marker, generation: randomUUID() },
            marker,
            { entries: [], origins: [] },
            store.epoch(),
          ),
        );
        await redis.execute(["HDEL", store.keys[1], digest]);
        await assert.rejects(coordinator.classify({ digest, ip: "198.18.0.5" }));
        assert.equal(coordinator.ready(), false);
        await assert.rejects(
          coordinator.classify({ digest: "f".repeat(64), ip: "198.18.0.5" }),
          RecognitionUnavailable,
        );
        await coordinator.reconcile();
      },
    );
    await t.test(
      "two native Bun replicas isolate unknown and noisy same-NAT traffic with actual handlers and 10ms primary delay",
      async () => {
        const noisyKey = generatePartnerApiKey(),
          noisyId = randomUUID();
        const internalKey = generatePartnerApiKey(),
          internalId = randomUUID();
        const revokedKey = generatePartnerApiKey(),
          revokedId = randomUUID();
        const exhaustedKey = generatePartnerApiKey(),
          exhaustedId = randomUUID();
        const siblingKey = generatePartnerApiKey(),
          siblingId = randomUUID();
        await coordinator.write(async (transaction) => {
          await transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,'noisy','Flood',$2,'operator:test')",
              [noisyId, hashPartnerApiKey(noisyKey)],
            );
          await transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by,tier,requests_per_minute,requests_per_day) VALUES ($1,'quiet','Internal',$2,'operator:test','internal',NULL,NULL)",
              [internalId, hashPartnerApiKey(internalKey)],
            );
        });
        await coordinator.write((transaction) =>
          transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by) VALUES ($1,'quiet','Revoked flood',$2,'operator:test')",
              [revokedId, hashPartnerApiKey(revokedKey)],
            ),
        );
        await coordinator.write(async (transaction) => {
          await transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by,tier,requests_per_minute,requests_per_day) VALUES ($1,'quiet','Daily exhausted',$2,'operator:test','custom',1,1),($3,'quiet','Paid sibling',$4,'operator:test','custom',299,50000)",
              [
                exhaustedId,
                hashPartnerApiKey(exhaustedKey),
                siblingId,
                hashPartnerApiKey(siblingKey),
              ],
            );
        });
        await coordinator.write((transaction) =>
          transaction
            .forModule("partner-api-keys")
            .write(
              "partner_api_keys",
              "UPDATE partner_api_keys SET revoked_at=now(),revoked_by='operator:test' WHERE id=$1",
              [revokedId],
            ),
        );
        const nativeCapacity = {
          ...capacity,
          tenants: capacity.tenants.map((tenant) =>
            tenant.id === "quiet"
              ? {
                  ...tenant,
                  requestsPerMinute: 600,
                  keyRequestsPerMinute: 3000,
                }
              : tenant,
          ),
        };
        const proxy = await startDelayedTcpProxy(target, 5);
        const delayedDatabase = new URL(target);
        delayedDatabase.port = String(proxy.port);
        const upstream = createHttpServer((_, response) => {
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ fixture: true }));
        });
        upstream.listen(0, "127.0.0.1");
        await once(upstream, "listening");
        const upstreamPort = (upstream.address() as { port: number }).port;
        const children: ChildProcess[] = [];
        const logs = ["", ""];
        const nativeEnvironment = {
          ...RUNTIME_TEST_ENVIRONMENT,
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: String(delayedDatabase),
          DATABASE_REPLICA_URL: localReplicaUrl(String(delayedDatabase)),
          PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(
            String(target),
            t,
            String(delayedDatabase),
          ),
          BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
          BLAST_BACKEND_INGRESS_MODE: "direct",
          BLAST_PARTNER_CAPACITY_CONFIG: JSON.stringify(nativeCapacity),
          BLAST_QUOTA_REDIS_URL: redisUrl,
          BLAST_REDIS_NAMESPACE: namespace + ":native",
          RATE_LIMIT_SUBJECT_PEPPER: pepper,
          BLAST_BACKEND_GATEWAY_SECRET: "synthetic-native-gateway-01234567890123456789",
          BLAST_INFRA_ORIGIN: `http://127.0.0.1:${upstreamPort}`,
          BLAST_INFRA_API_KEY: "synthetic-native-infra-key-01234567890123456789",
          NEXT_PUBLIC_SITE_URL: "https://frontend.test",
          BLAST_DEPLOYMENT_TARGET: "preview",
          BLAST_DEPLOYMENT_BRANCH: "native-fairness-fixture",
          MISSION_CONTROL_METRICS: "on",
        };
        const childNamespace = quotaNamespace(
          nativeEnvironment.BLAST_REDIS_NAMESPACE,
          deploymentIdentity(nativeEnvironment),
        );
        const primaryReads = () =>
          logs.reduce(
            (sum, log) => sum + (log.match(/"label":"partner.api_key"/g) ?? []).length,
            0,
          );
        const origins: string[] = [];
        try {
          for (let replica = 0; replica < 2; replica++) {
            origins.push(
              await startNativeReplica(
                nativeEnvironment,
                children,
                (chunk) => {
                  logs[replica] = (logs[replica] + chunk).slice(-1_000_000);
                },
                () => logs[replica],
              ),
            );
          }
          const nativeCoordinator = new PartnerRecognition(
            pool,
            new PartnerRecognitionStore(redis, childNamespace, pepper, nativeCapacity),
          );
          await nativeCoordinator.reconcile();
          const read = async (replica: number, presented: string, origin?: string) => {
            const answer = await fetch(origins[replica] + "/api/v1/market/status", {
              headers: {
                "x-blast-partner-key": presented,
                ...(origin ? { origin } : {}),
              },
            });
            await answer.arrayBuffer();
            return answer.status;
          };
          for (const replica of [0, 1]) {
            assert.equal(await read(replica, key), 200);
          }
          await pause(20);
          const beforeUnknown = primaryReads();
          const unknownStatuses = await Promise.all(
            Array.from({ length: 120 }, (_, index) => read(index % 2, generatePartnerApiKey())),
          );
          for (let admitted = 0; admitted < 110; admitted++) {
            unknownStatuses.push(await read(admitted % 2, generatePartnerApiKey()));
          }
          await pause(20);
          const unknownPrimaryReads = primaryReads() - beforeUnknown;
          assert.equal(
            unknownPrimaryReads,
            0,
            "unknown flood produces zero primary key-verification SQL",
          );
          assert.ok(unknownStatuses.every((status) => [401, 429, 503].includes(status)));
          assert.ok(
            unknownStatuses.includes(429),
            "shared unknown admission is actually exhausted",
          );
          for (const replica of [0, 1]) {
            const preflight = await fetch(origins[replica] + "/api/v1/market/status", {
              method: "OPTIONS",
              headers: {
                origin: "https://quiet.example",
                "access-control-request-method": "GET",
                "access-control-request-headers": "x-blast-partner-key",
              },
            });
            await preflight.arrayBuffer();
            assert.equal(
              preflight.status,
              204,
              "recognized-origin reserve remains available after unknown flood exhaustion",
            );
          }
          for (const replica of [0, 1]) {
            assert.equal(
              await read(replica, key),
              200,
              "same NAT unknown flood cannot spend a recognized tenant's admission",
            );
          }
          const quietStatuses: number[] = [],
            noiseStatuses: number[] = [],
            quietLatency: number[] = [];
          const until = performance.now() + 3_000;
          const quiet = async () => {
            while (performance.now() < until) {
              const started = performance.now();
              quietStatuses.push(await read(quietStatuses.length % 2, key));
              quietLatency.push(performance.now() - started);
              await pause(50);
            }
          };
          const noise = async (worker: number) => {
            while (performance.now() < until) {
              noiseStatuses.push(await read(worker % 2, noisyKey));
              await pause(5);
            }
          };
          const unknown = async () => {
            while (performance.now() < until) {
              await read(0, generatePartnerApiKey());
              await pause(10);
            }
          };
          await Promise.all([quiet(), noise(0), noise(1), unknown()]);
          assert.ok(quietStatuses.length >= 20);
          assert.ok(
            quietStatuses.every((status) => status === 200),
            "recognized quiet key stays available under bounded same-NAT noisy/unknown traffic",
          );
          assert.ok(noiseStatuses.length > quietStatuses.length);
          const tenantCounter = `${childNamespace}:{partner-quota}:recognition-admission:tenant:${createHmac("sha256", pepper).update("recognition.tenant:quiet").digest("hex")}`;
          assert.equal(
            await read(0, exhaustedKey),
            200,
            "one real call exhausts the one/day policy",
          );
          const responseBeforeExhaustedFlood = await redis.execute(["GET", tenantCounter]);
          const exhaustedStatuses: number[] = [];
          for (let index = 0; index < 620; index++) {
            exhaustedStatuses.push(await read(index % 2, exhaustedKey));
            if (index % 100 === 0) {
              assert.equal(await read(index % 2, exhaustedKey, "https://wrong.example"), 403);
            }
          }
          assert.ok(exhaustedStatuses.every((status) => status === 429));
          assert.equal(
            await redis.execute(["GET", tenantCounter]),
            responseBeforeExhaustedFlood,
            "commercial/day and wrong-Origin refusals spend zero tenant operational allowance",
          );
          assert.equal(
            await read(0, siblingKey),
            200,
            "within-quota paid sibling remains admitted after more than tenant-cap denied calls",
          );
          // Reach the existing endpoint budgets with both paid siblings; refused calls never add usage.
          let paidIndex = 0;
          await Promise.all(
            Array.from({ length: 4 }, (_, worker) =>
              (async () => {
                while (paidIndex++ < 1250) {
                  await read(worker % 2, paidIndex % 2 ? key : siblingKey);
                }
              })(),
            ),
          );
          assert.ok(
            String(await redis.execute(["GET", tenantCounter])).endsWith(":241"),
            "two paid keys reach their unchanged 120/minute endpoint caps plus the one/day key; refusals spend zero allowance",
          );
          const siblingHash = createHmac("sha256", pepper)
            .update(
              rateLimitSubjectKey(DEFAULT_RATE_POLICIES.partner_read, {
                apiKeyId: siblingId,
              }),
            )
            .digest("hex");
          const siblingCounters = [60, 86400].map(
            (seconds) =>
              `${childNamespace}:{partner-quota}:partner_read:v1:${siblingHash}:${seconds}`,
          );
          const commercialBeforeOperationalRefusal = await Promise.all(
            siblingCounters.map((counter) => redis.execute(["GET", counter])),
          );
          assert.ok([429, 503].includes(await read(0, siblingKey)));
          assert.deepEqual(
            await Promise.all(siblingCounters.map((counter) => redis.execute(["GET", counter]))),
            commercialBeforeOperationalRefusal,
            "operational/commercial refusals cannot partially increment either paid window",
          );
          const paidAtCap = await redis.execute(["GET", tenantCounter]);
          const revokedStatuses: number[] = [];
          let revokedIndex = 0;
          await Promise.all(
            Array.from({ length: 4 }, (_, worker) =>
              (async () => {
                while (revokedIndex++ < 610) {
                  revokedStatuses.push(await read(worker % 2, revokedKey));
                }
              })(),
            ),
          );
          assert.ok(
            revokedStatuses.every((status) => status === 401 || status === 429),
            "revoked or trimmed identities cannot authenticate or borrow paid/internal response capacity",
          );
          assert.equal(
            await redis.execute(["GET", tenantCounter]),
            paidAtCap,
            "revoked/trimmed refusals do not spend the operational response reservation",
          );
          const internalStatuses: number[] = [],
            mixedPaidStatuses: number[] = [];
          const mixedUntil = performance.now() + 3_000;
          await Promise.all([
            (async () => {
              while (performance.now() < mixedUntil) {
                internalStatuses.push(await read(internalStatuses.length % 2, internalKey));
                await pause(50);
              }
            })(),
            ...[0, 1].map((replica) =>
              (async () => {
                while (performance.now() < mixedUntil) {
                  mixedPaidStatuses.push(await read(replica, key));
                  await pause(5);
                }
              })(),
            ),
          ]);
          assert.ok(internalStatuses.length >= 20);
          assert.ok(
            internalStatuses.every((status) => status === 200),
            "fresh internal grants in the same mixed tenant keep their separate response lane",
          );
          assert.ok(mixedPaidStatuses.every((status) => [200, 429, 503].includes(status)));
          const commercialIdentity = createHmac("sha256", pepper)
            .update(
              rateLimitSubjectKey(DEFAULT_RATE_POLICIES.partner_read, {
                apiKeyId: internalId,
              }),
            )
            .digest("hex");
          assert.deepEqual(
            await redis.execute([
              "KEYS",
              `${childNamespace}:{partner-quota}:partner_read:v1:${commercialIdentity}:*`,
            ]),
            [],
            "internal access never creates paid quota counters",
          );
          assert.ok(
            await redis.execute([
              "GET",
              `${childNamespace}:{partner-quota}:recognition-admission:internal`,
            ]),
            "internal physical admission has its own bounded counter",
          );
          const quotaNames = (await redis.execute([
            "KEYS",
            `${childNamespace}:*:partner_read:*`,
          ])) as string[];
          const paidBefore = await Promise.all(
            quotaNames.map((counter) => redis.execute(["GET", counter])),
          );
          const childStore = new PartnerRecognitionStore(
            redis,
            childNamespace,
            pepper,
            nativeCapacity,
          );
          const childCoordinator = new PartnerRecognition(pool, childStore);
          await childCoordinator.reconcile();
          assert.deepEqual(
            await Promise.all(quotaNames.map((counter) => redis.execute(["GET", counter]))),
            paidBefore,
            "reconciliation does not reset or spend paid counters",
          );
          const sorted = quietLatency.toSorted((a, b) => a - b);
          t.diagnostic(
            JSON.stringify({
              scope:
                "local two native Bun processes, real primary authorization/canonical market handler, loopback upstream fixture",
              replicas: 2,
              primaryDelayMs: 10,
              durationMs: 3000,
              quiet: quietStatuses.length,
              noisy: noiseStatuses.length,
              unknownPrimaryReads,
              quietP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
              exhaustion: {
                configuredPaidTenantCap: 600,
                actualEndpointBoundAdmitted: 241,
                revoked: revokedStatuses.length,
                revokedOnly401Or429: true,
                validDailyExhausted: exhaustedStatuses.length,
                siblingAfterExhaustion200: true,
              },
              mixedTenantInternal: {
                reads: internalStatuses.length,
                successful: internalStatuses.filter((status) => status === 200).length,
                noisyPaid: mixedPaidStatuses.length,
              },
              commercialPoliciesUnchanged: true,
              limits: "not Rust cold-read, hosted capacity or distributed-attack immunity evidence",
            }),
          );
        } finally {
          await stopChildren(children);
          await upstream.closeAllConnections();
          await new Promise<void>((resolve) => upstream.close(() => resolve()));
          await proxy.close();
        }
      },
    );
    assert.deepEqual((await pool.query("SELECT * FROM retained_accounts")).rows, privateBefore);
    assert.deepEqual(
      await Promise.all(quotaKeys.map((counter) => redis.execute(["GET", counter]))),
      usageBefore,
    );
    assert.equal((await reader.verify(key))?.keyId, keyId);
    const grants = await pool.query(
      "SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name='partner_api_recognition' AND grantee='PUBLIC'",
    );
    assert.deepEqual(grants.rows, []);
  },
);

/** A loopback TCP proxy that delays every relayed chunk by `delayMs` (one chunk in flight per direction). */
async function startDelayedTcpProxy(target: URL, delayMs: number) {
  const sockets = new Set<Socket>();
  const relay = (source: Socket, destination: Socket) => {
    source.on("data", (chunk) => {
      source.pause();
      setTimeout(() => {
        if (destination.destroyed) {
          return;
        }
        destination.write(chunk, () => source.resume());
      }, delayMs);
    });
    source.on("error", () => destination.destroy());
    source.on("close", () => {
      sockets.delete(source);
      destination.destroy();
    });
  };
  const proxy = createServer((incoming) => {
    const outgoing = connect({ host: "127.0.0.1", port: Number(target.port) });
    sockets.add(incoming);
    sockets.add(outgoing);
    relay(incoming, outgoing);
    relay(outgoing, incoming);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  return {
    port: (proxy.address() as { port: number }).port,
    async close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    },
  };
}

/** Spawns the real backend main on a free port and waits (bounded) until it reports ready. */
async function startNativeReplica(
  environment: Record<string, string | undefined>,
  children: ChildProcess[],
  onOutput: (chunk: string) => void,
  log: () => string,
): Promise<string> {
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
  const replica = children.length;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout!, child.stderr!]) {
    stream.on("data", (chunk) => onOutput(chunk.toString()));
  }
  const origin = `http://127.0.0.1:${port}`;
  const started = performance.now();
  // Allow startup and dependency probes to recover under load. Two replicas
  // still leave most of the suite's 120 s budget for the traffic assertions.
  const deadline = started + 15_000;
  let lastProbe = "no response";

  function readinessError(reason: string) {
    const elapsed = Math.round(performance.now() - started);
    const output = log().slice(-4_000).trim() || "(no child output)";
    return new Error(
      `Native replica ${replica} at ${origin} ${reason} after ${elapsed} ms. Last /v1/health probe: ${lastProbe}.\n${output}`,
    );
  }

  while (performance.now() < deadline) {
    if (spawnError) {
      throw readinessError(`failed to spawn (${spawnError.message})`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw readinessError(
        `exited (code ${child.exitCode}, signal ${child.signalCode}) before readiness`,
      );
    }
    try {
      const { status, body } = await fetch(origin + "/v1/health", {
        signal: AbortSignal.timeout(
          Math.min(1_000, Math.max(1, Math.ceil(deadline - performance.now()))),
        ),
      });
      await body?.cancel();
      lastProbe = `HTTP ${status}`;
      if (status === 200) {
        return origin;
      }
    } catch (error) {
      lastProbe = error instanceof Error ? error.message : String(error);
    }
    await pause(Math.min(50, Math.max(0, deadline - performance.now())));
  }
  throw readinessError("did not become ready");
}

/** SIGTERM each owned child, escalating to SIGKILL after 5 s. */
async function stopChildren(children: readonly ChildProcess[]): Promise<void> {
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      continue;
    }
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await ended;
    clearTimeout(timer);
  }
}
