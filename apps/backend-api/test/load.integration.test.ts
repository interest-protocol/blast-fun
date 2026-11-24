import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import { configuredPartnerRecognition } from "@blast/server/modules/partner-api-keys/recognition.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import assert from "node:assert/strict";
import { fork, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { importPKCS8, SignJWT } from "jose";
import { Pool } from "pg";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import {
  createPartner,
  issuePartnerApiKey,
  revokePartnerApiKey,
  setPartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/repository.ts";
import {
  localReplicaUrl,
  RUNTIME_TEST_ENVIRONMENT,
} from "../../../packages/server/test/fixtures/config/runtime-config.ts";

const durationMs = Number(process.env.BLAST_BACKEND_LOAD_DURATION_MS ?? "3000");

async function freePort(): Promise<number> {
  const server = createTcpServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await ended;
  clearTimeout(timer);
}

function summary(values: number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const percentile = (fraction: number) =>
    Number(
      (sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0).toFixed(
        2,
      ),
    );
  return {
    count: values.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}

test(
  "sustained mixed physical-process admission with 10k keys and controlled database/Redis RTT",
  { timeout: durationMs * 2 + 90_000 },
  async (t) => {
    const database = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
    const redisUrl = process.env.BLAST_TEST_REDIS_URL;
    assert.ok(database && redisUrl, "Disposable PostgreSQL/Valkey are mandatory.");
    assert.equal(new URL(database).hostname, "127.0.0.1");
    assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
    const pool = new Pool({ connectionString: database, max: 1 });
    t.after(() => pool.end());
    await migrateDatabase(pool);
    const recognitionEnvironment = {
      BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
      BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["backend-load"]),
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
    await createPartner(pool, { id: "backend-load", origins: [] }, "operator:test");
    const partner = await issuePartnerApiKey(pool, "backend-load", "mixed-load", "operator:test");
    await setPartnerKeyPolicy(
      pool,
      partner.id,
      { tier: "custom", requestsPerMinute: 100_000, requestsPerDay: 100_000 },
      "operator:test",
    );
    // Same 10k rows through the production recognition write; each chunk stays inside its 2s statement budget.
    const recognition = configuredPartnerRecognition(pool);
    for (let first = 1; first <= 10_000; first += 1_000) {
      await recognition.write((transaction) =>
        transaction.forModule("partner-api-keys").write(
          "partner_api_keys",
          `INSERT INTO partner_api_keys(id,partner_id,label,key_hash,issued_by,policy_updated_by)
      SELECT gen_random_uuid(),'backend-load','registry-'||g,decode(lpad(to_hex(g),64,'0'),'hex'),'operator:test','operator:test' FROM generate_series($1::int,$2::int) g`,
          [first, first + 999],
        ),
      );
    }
    await pool.query("ANALYZE partner_api_keys");
    const walletToken = "z".repeat(43);
    await pool.query(
      `INSERT INTO social_wallet_sessions(session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at)
    VALUES($1,$2,$3,$4,now(),now()+interval '1 day',now())`,
      [randomUUID(), walletSessionTokenHash(walletToken), "0x" + "b".repeat(64), randomUUID()],
    );
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signingKey = await importPKCS8(
      pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "ES256",
    );
    const token = await new SignJWT({ sid: "existing-load-session" })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("privy.io")
      .setAudience("test-existing-app")
      .setSubject("did:privy:existing-load-user")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(signingKey);
    let upstreamReads = 0;
    // The marker is a published status field: `/v1/status` keeps only those (#605), and every
    // other read is relayed as it is.
    const upstream = createServer((_request, response) => {
      upstreamReads++;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"provenance":"load-fixture"}');
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const base = {
      ...RUNTIME_TEST_ENVIRONMENT,
      PATH: process.env.PATH,
      NODE_ENV: "test",
      TZ: "UTC",
      MISSION_CONTROL_METRICS: "off",
      BLAST_BACKEND_INGRESS_MODE: "direct",
      BLAST_BACKEND_GATEWAY_SECRET: "synthetic-gateway-secret-012345678901234567890123",
      BLAST_INFRA_ORIGIN: upstreamOrigin,
      BLAST_INFRA_API_KEY: "synthetic-infra-key-012345678901234567890123",
      NEXT_PUBLIC_SITE_URL: "https://frontend.test",
      PRIVY_APP_ID: "test-existing-app",
      PRIVY_JWT_VERIFICATION_KEY: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      RATE_LIMIT_SUBJECT_PEPPER: "synthetic-pepper-012345678901234567890123456789",
      BLAST_DEPLOYMENT_TARGET: "preview",
      BLAST_DEPLOYMENT_BRANCH: "load-only",
    };
    Object.assign(base, recognitionEnvironment);
    assert.ok(Number.isFinite(durationMs) && durationMs >= 1000 && durationMs <= 600_000);
    const results: unknown[] = [];
    const unexpectedExits: unknown[] = [];
    for (const rttMs of [0, 12]) {
      const children: ChildProcess[] = [];
      const containers: string[] = [];

      async function proxy(raw: string, force = false) {
        if (!rttMs && !force) {
          return { url: raw, async disconnect() {}, async reconnect() {} };
        }
        const target = new URL(raw);
        const targetPort = target.port || "6379";
        const port = await freePort();
        let child: ChildProcess;

        async function connect() {
          child = fork(
            new URL("../../web/loadtest/lib/latency-proxy.mjs", import.meta.url),
            [
              "--listen",
              String(port),
              "--target",
              `127.0.0.1:${targetPort}`,
              "--rtt-ms",
              String(rttMs),
            ],
            {
              execArgv: [],
              stdio: ["ignore", "pipe", "ignore", "ipc"],
              env: { PATH: process.env.PATH },
            },
          );
          children.push(child);
          await once(child.stdout!, "data");
        }

        await connect();
        target.port = String(port);
        return { url: target.href, disconnect: () => stop(child), reconnect: connect };
      }

      const databaseProxy = await proxy(database);
      const redisProxy = await proxy(redisUrl, true);
      const environment = {
        ...base,
        DATABASE_URL: databaseProxy.url,
        PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t, databaseProxy.url),
        DATABASE_REPLICA_URL: localReplicaUrl(databaseProxy.url),
        BLAST_QUOTA_REDIS_URL: redisProxy.url,
      };

      async function start(file: string, extra: Record<string, string> = {}, fixedPort?: number) {
        const port = fixedPort ?? (await freePort());
        const env = { ...environment, ...extra, PORT: String(port) };
        const execArgv: string[] = [];
        let child: ChildProcess;
        if (process.env.BLAST_BACKEND_TEST_CGROUP === "512" && file.includes("benchmark-process")) {
          const name = `blast-backend-load-${randomUUID()}`;
          containers.push(name);
          const checkout = fileURLToPath(new URL("../../../", import.meta.url));
          const mountRoot = (path: string, parent = ".") => {
            const location = new URL(path, import.meta.url);
            return existsSync(location) ? resolve(realpathSync(location), parent) : null;
          };
          // Keep external dependency trees reachable even when individual packages are linked.
          const dependencyRoots = new Set(
            [
              mountRoot("../../../node_modules"),
              mountRoot("../node_modules"),
              mountRoot("../../../packages/core/node_modules"),
              mountRoot("../../../packages/server/node_modules"),
              mountRoot("../../../packages/core/node_modules/jose", ".."),
              mountRoot("../../../node_modules/zod", ".."),
              mountRoot("../../../node_modules/@redis"),
              mountRoot("../../../node_modules/@redis/client", "../.."),
            ].filter((path) => path !== null && !path.startsWith(checkout)),
          );
          child = spawn(
            "docker",
            [
              "run",
              "--rm",
              "--name",
              name,
              "--memory=512m",
              "--memory-swap=512m",
              "--network",
              "host",
              "--read-only",
              "--tmpfs",
              "/tmp:size=16m",
              "--user",
              `${process.getuid!()}:${process.getgid!()}`,
              "--mount",
              `type=bind,src=${checkout},dst=${checkout},readonly`,
              ...Array.from(dependencyRoots).flatMap((path) => [
                "--mount",
                `type=bind,src=${path},dst=${path},readonly`,
              ]),
              "--mount",
              `type=bind,src=${process.execPath},dst=${process.execPath},readonly`,
              "--workdir",
              checkout,
              ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
              "--entrypoint",
              process.execPath,
              "postgres:16.15-trixie",
              ...execArgv,
              new URL(file, import.meta.url).pathname,
            ],
            { stdio: ["ignore", "ignore", "pipe"] },
          );
        } else {
          child = fork(new URL(file, import.meta.url), [], {
            execArgv,
            env,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          });
        }
        let startupErrors = "";
        children.push(child);
        child.stderr!.on("data", (chunk) => {
          startupErrors = (startupErrors + chunk.toString()).slice(-2000);
        });
        child.on("exit", (code, signal) => {
          if (code) {
            unexpectedExits.push({ file, code, signal });
          }
        });
        const origin = `http://127.0.0.1:${port}`;
        if (file.includes("relay-process")) {
          await once(child, "message");
          return { child, origin };
        }
        for (let attempt = 0; attempt < 500; attempt++) {
          if (child.exitCode !== null) {
            throw new Error(`Load fixture exited before readiness: ${startupErrors}`);
          }
          // Like a load balancer, send traffic only once the replica reports ready.
          try {
            if ((await fetch(origin + "/v1/health")).status === 200) {
              return { child, origin };
            }
          } catch {
            /* Starting socket. */
          }
          await pause(30);
        }
        throw new Error(`Load fixture failed to start: ${startupErrors}`);
      }

      try {
        let first = await start("./benchmark-process.ts");
        const second = await start("./benchmark-process.ts");
        const relay = await start("./relay-process.ts", { TEST_BACKEND_ORIGIN: second.origin });
        const timings = new Map<string, number[]>();
        const failures: number[] = [];
        let index = 0;
        let maintenance = false;
        let active = 0;
        let recoveryEvidence: unknown;
        const priorBackendStats: unknown[] = [];
        const until = performance.now() + durationMs;
        const started = performance.now();
        const lanes = [
          "partner-cold",
          "partner-warm",
          "partner-relay",
          "privy-user",
          "wallet-user",
          "anonymous",
          "partner-warm",
          "partner-cold",
        ] as const;

        function workload(current: number) {
          const lane = current % lanes.length;
          const cohort = lanes[lane];
          const firstParty = ["privy-user", "wallet-user", "anonymous"].includes(cohort);
          const id =
            "0x" + (cohort === "partner-cold" ? current + 1 : 0).toString(16).padStart(64, "0");
          const path = firstParty
            ? "/api/launchpad/market/status"
            : `/api/v1/market/pools/blast_curve/${id}`;
          const targets = [second, first, relay, relay, relay, relay, second, first];
          const headers: Record<string, string> = firstParty
            ? { origin: "https://frontend.test", "sec-fetch-site": "same-origin" }
            : { "x-blast-partner-key": partner.key };
          if (cohort === "privy-user") {
            headers.authorization = `Bearer ${token}`;
          }
          if (cohort === "wallet-user") {
            headers.cookie = `__Host-blast_wallet=${walletToken}`;
          }
          return { cohort, url: targets[lane].origin + path, headers };
        }

        async function worker() {
          while (performance.now() < until) {
            if (maintenance) {
              await pause(10);
              continue;
            }
            active++;
            const request = workload(index++);
            const before = performance.now();
            const response = await fetch(request.url, { headers: request.headers }).catch(
              (cause) => {
                throw new Error(
                  `Transport failed for ${request.cohort} after ${index} requests; exits=${JSON.stringify(unexpectedExits)}`,
                  { cause },
                );
              },
            );
            const answer = await response.json();
            if (response.status !== 200 || answer.provenance !== "load-fixture") {
              failures.push(response.status);
            }
            const values = timings.get(request.cohort) ?? [];
            values.push(performance.now() - before);
            timings.set(request.cohort, values);
            active--;
          }
        }

        async function recovery() {
          await pause(durationMs / 2);
          maintenance = true;
          while (active) {
            await pause(10);
          }
          const path = "/api/v1/market/status";
          const canary = await issuePartnerApiKey(
            pool,
            "backend-load",
            "policy-canary",
            "operator:test",
          );
          const survivor = await issuePartnerApiKey(
            pool,
            "backend-load",
            "restart-canary",
            "operator:test",
          );
          const read = (origin: string, key: string) =>
            fetch(origin + path, { headers: { "x-blast-partner-key": key } });
          await setPartnerKeyPolicy(
            pool,
            canary.id,
            { tier: "custom", requestsPerMinute: 4, requestsPerDay: 4 },
            "operator:test",
          );
          assert.equal((await read(first.origin, canary.key)).status, 200);
          await setPartnerKeyPolicy(
            pool,
            canary.id,
            { tier: "custom", requestsPerMinute: 1, requestsPerDay: 1 },
            "operator:test",
          );
          assert.equal((await read(second.origin, canary.key)).status, 429);
          await setPartnerKeyPolicy(
            pool,
            canary.id,
            { tier: "custom", requestsPerMinute: 4, requestsPerDay: 4 },
            "operator:test",
          );
          assert.equal((await read(relay.origin, canary.key)).status, 200);
          await revokePartnerApiKey(pool, canary.id, "operator:test");
          assert.equal((await read(first.origin, canary.key)).status, 401);
          assert.equal((await read(second.origin, canary.key)).status, 401);
          await setPartnerKeyPolicy(
            pool,
            survivor.id,
            { tier: "custom", requestsPerMinute: 4, requestsPerDay: 4 },
            "operator:test",
          );
          assert.equal((await read(first.origin, survivor.key)).status, 200);
          await redisProxy.disconnect();
          assert.equal(
            (await read(second.origin, survivor.key)).status,
            503,
            "Disconnected quota Redis fails closed.",
          );
          assert.equal(
            (
              await fetch(relay.origin + "/api/launchpad/market/status", {
                headers: {
                  authorization: `Bearer ${token}`,
                  origin: "https://frontend.test",
                  "sec-fetch-site": "same-origin",
                },
              })
            ).status,
            503,
          );
          await redisProxy.reconnect();
          let recovered = 503;
          for (let attempt = 0; attempt < 30 && recovered === 503; attempt++) {
            await pause(100);
            await fetch(second.origin + "/v1/health");
            recovered = (await read(second.origin, survivor.key)).status;
          }
          assert.equal(recovered, 200);
          await fetch(first.origin + "/v1/health");
          assert.equal((await read(relay.origin, survivor.key)).status, 200);
          const port = Number(new URL(first.origin).port);
          priorBackendStats.push(
            await fetch(first.origin + "/test/process-stats").then((response) => response.json()),
          );
          await stop(first.child);
          first = await start("./benchmark-process.ts", {}, port);
          assert.equal((await read(first.origin, survivor.key)).status, 200);
          assert.equal(
            (await read(relay.origin, survivor.key)).status,
            429,
            "All four pre/post outage/restart reads share one surviving daily allowance.",
          );
          recoveryEvidence = {
            freshPolicyAcrossReplicas: true,
            freshRevocationAcrossReplicas: true,
            redisDisconnectedFailClosed: true,
            redisRecovered: true,
            restartedBackend: true,
            survivingDailyCounter: true,
            noDuplicateRelayCharge: true,
          };
          maintenance = false;
        }

        await Promise.all([...Array.from({ length: 8 }, worker), recovery()]);
        const elapsedMs = performance.now() - started;
        assert.deepEqual(
          failures,
          [],
          "Synthetic capacity policy must not hide unexpected transport/authentication/storage failures.",
        );
        const stats = [...priorBackendStats];
        for (const backend of [first, second]) {
          stats.push(
            await fetch(backend.origin + "/test/process-stats").then((response) => response.json()),
          );
        }
        results.push({
          rttMs,
          elapsedMs: Number(elapsedMs.toFixed(2)),
          requests: index,
          concurrency: 8,
          rps: Number(((index * 1000) / elapsedMs).toFixed(2)),
          cohorts: Object.fromEntries(
            [...timings].map(([name, values]) => [name, summary(values)]),
          ),
          backends: stats,
          recovery: recoveryEvidence,
        });
      } finally {
        for (const child of children.reverse()) {
          await stop(child);
        }
        for (const name of containers) {
          spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
        }
      }
    }
    assert.equal(
      Number((await pool.query("SELECT count(*) FROM social_accounts")).rows[0].count),
      0,
    );
    t.diagnostic(
      JSON.stringify({
        registryKeys: 10_005,
        durationMsPerProfile: durationMs,
        syntheticQuotaPolicy: true,
        runtime: `Bun ${Bun.version}`,
        heapLimitMiB: null,
        cgroupMemoryMiB: process.env.BLAST_BACKEND_TEST_CGROUP === "512" ? 512 : null,
        commercialPolicyUnchanged:
          "Per-key minute/day identities and entitlements preserved; operational global envelope explicitly configured",
        upstream: "loopback HTTP fixture, not Rust engine",
        upstreamReads,
        profiles: results,
      }),
    );
  },
);
