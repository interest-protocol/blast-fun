import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture, runtimeRoleFixture } from "./partner-verifier-fixture.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { waitForHealth } from "./kit.ts";
import assert from "node:assert/strict";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { importPKCS8, SignJWT } from "jose";
import { Pool } from "pg";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import {
  DEFAULT_RATE_POLICIES,
  rateLimitSubjectKey,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import {
  INTERNAL_READ_PREFIX,
  signGatewayRequest,
} from "@blast/core/modules/backend-api/gateway.ts";
import { walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { PARTNER_ENDPOINT_POLICIES } from "@blast/server/modules/partner-api-keys/runtime.ts";
import {
  createPartner,
  issuePartnerApiKey,
  revokePartnerApiKey,
  setPartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/repository.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../packages/server/test/fixtures/config/runtime-config.ts";

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
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 3_000);
  await closed;
  clearTimeout(kill);
}

async function waitForAdmissionRecovery(read: () => Promise<Response>, status: number) {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const response = await read();
    if (response.status === status) {
      await response.body?.cancel();
      return;
    }
    assert.equal(response.status, 503, "Recovery must never grant a refused request.");
    assert.equal((await response.json()).error.code, "partner_api_unavailable");
    assert.ok(performance.now() < deadline, "Admission must recover within five seconds.");
    await pause(100);
  }
}

test(
  "physical backend replicas and frontend relay preserve fresh keys, shared quotas and sessions",
  { timeout: 90_000 },
  async (t) => {
    const database = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
    const redisUrl = process.env.BLAST_TEST_REDIS_URL;
    const redisContainer = process.env.BLAST_TEST_REDIS_CONTAINER;
    assert.ok(
      database && redisUrl,
      "Run with task-owned disposable PostgreSQL and Valkey; integration must not silently skip.",
    );
    assert.equal(new URL(database).hostname, "127.0.0.1");
    assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
    assert.match(redisContainer ?? "", /^blast-v2-disposable-redis-\d+$/);
    const pool = new Pool({ connectionString: database, max: 1 });
    const redis = createRedisConnection(redisUrl, "quota");
    t.after(async () => {
      redis.close();
      await pool.end();
    });
    await migrateDatabase(pool);
    const recognitionEnvironment = {
      BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
      // The 24-request burst below sends 12 same-key requests per replica; a per-key queue of
      // floor(32 / 2) = 16 admits them all, so its exact shared-quota split is deterministic.
      BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["standalone-test", "admin-created"], 32),
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
    await createPartner(
      pool,
      { id: "standalone-test", origins: ["https://allowed.test"] },
      "operator:test",
    );
    const key = await issuePartnerApiKey(
      pool,
      "standalone-test",
      "shared-stable-key",
      "operator:test",
    );
    await setPartnerKeyPolicy(
      pool,
      key.id,
      { tier: "custom", requestsPerMinute: 5, requestsPerDay: 6 },
      "operator:test",
    );
    const originalHash = (
      await pool.query("SELECT encode(key_hash, 'hex') AS hash FROM partner_api_keys WHERE id=$1", [
        key.id,
      ])
    ).rows[0].hash;
    let upstreamReads = 0;
    const upstream = createServer((request, response) => {
      upstreamReads++;
      if (request.url === "/" || request.url === "/version") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end(request.url === "/" ? "OK" : "local-fixture");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/v1/status"
            ? { fixture: true, engine_id: "private-host" }
            : { fixture: true },
        ),
      );
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
    const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const gatewaySecret = "test-only-gateway-secret-012345678901234567890123";
    const adminSecret = "test-only-operator-secret-012345678901234567890";
    const environment = {
      ...RUNTIME_TEST_ENVIRONMENT,
      PATH: process.env.PATH,
      NODE_ENV: "test",
      TZ: "UTC",
      DATABASE_URL: await runtimeRoleFixture(database, t, "blast_web"),
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
      DATABASE_REPLICA_URL: await runtimeRoleFixture(database, t, "blast_replica"),
      BLAST_QUOTA_REDIS_URL: redisUrl,
      BLAST_REDIS_NAMESPACE: `backend-test:${randomUUID()}`,
      RATE_LIMIT_SUBJECT_PEPPER: "test-only-pepper-012345678901234567890123456789",
      BLAST_BACKEND_INGRESS_MODE: "direct",
      BLAST_BACKEND_GATEWAY_SECRET: gatewaySecret,
      BLAST_INFRA_ORIGIN: upstreamOrigin,
      BLAST_INFRA_API_KEY: "test-only-infra-key-0123456789012345678901234567",
      PRESALE_ADMIN_TOKEN: adminSecret,
      PRESALE_GAS_POOL_URL: upstreamOrigin,
      NEXT_PUBLIC_SITE_URL: "https://frontend.test",
      PRIVY_APP_ID: "test-existing-app",
      PRIVY_JWT_VERIFICATION_KEY: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
      BLAST_DEPLOYMENT_TARGET: "preview",
      BLAST_DEPLOYMENT_BRANCH: "isolated-backend-test",
    };
    Object.assign(environment, recognitionEnvironment);
    for (const [url, membership] of [
      [environment.DATABASE_URL, "blast_web"],
      [environment.DATABASE_REPLICA_URL, "blast_replica"],
    ]) {
      const runtime = new Pool({ connectionString: url, max: 1 });
      try {
        const identity = (
          await runtime.query(`SELECT rolsuper, rolcreaterole, rolcreatedb,
          rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user`)
        ).rows[0];
        assert.ok(Object.values(identity).every((value) => value === false));
        assert.deepEqual(
          (
            await runtime.query(`SELECT r.rolname FROM pg_auth_members m
          JOIN pg_roles r ON r.oid = m.roleid
          WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`)
          ).rows,
          [{ rolname: membership }],
        );
        await assert.rejects(runtime.query("SET ROLE blast_migration"), { code: "42501" });
        await assert.rejects(runtime.query("SELECT rolpassword FROM pg_authid"), { code: "42501" });
        await assert.rejects(runtime.query("DELETE FROM coins WHERE FALSE"), { code: "42501" });
      } finally {
        await runtime.end();
      }
    }
    const namespace = quotaNamespace(
      environment.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(environment),
    );
    let captured = "";
    const start = async (file: string, extra: Record<string, string> = {}) => {
      const port = await freePort();
      const child = fork(new URL(file, import.meta.url), [], {
        execArgv: [],
        env: { ...environment, PORT: String(port), ...extra },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      child.stdout!.on("data", (chunk) => {
        captured = (captured + chunk.toString()).slice(-200_000);
      });
      child.stderr!.on("data", (chunk) => {
        captured = (captured + chunk.toString()).slice(-200_000);
      });
      t.after(() => stop(child));
      const origin = `http://127.0.0.1:${port}`;
      if (file.includes("relay-process")) {
        await once(child, "message");
      } else {
        await waitForHealth(child, origin, 40_000, "/v1/live");
      }
      return { origin, child };
    };
    const first = await start("../src/main.ts");
    let second = await start("../src/main.ts");
    const relay = await start("./relay-process.ts", { TEST_BACKEND_ORIGIN: first.origin });
    const call = (
      origin: string,
      path = "/api/v1/market/launches/0x" + "a".repeat(64) + "/activity?view=classified",
      headers: Record<string, string> = {},
    ) => fetch(origin + path, { headers: { "x-blast-partner-key": key.key, ...headers } });
    assert.equal((await fetch(first.origin + "/v1/health")).status, 200);
    const redisClock = (await redis.execute(["TIME"])) as string[];
    const windowLeft = 60 - (Number(redisClock[0]) % 60);
    if (windowLeft < 12) {
      await pause(windowLeft * 1_000 + 50);
    }

    for (const origin of [first.origin, second.origin, relay.origin]) {
      const response = await call(origin);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { fixture: true });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.ok(response.headers.get("x-request-id"));
    }
    assert.equal(
      upstreamReads,
      2,
      "Real public-handler cache coalesces per instance; hits still spend quota.",
    );
    const counters = (await redis.execute(["KEYS", `${namespace}:*:partner_read:*`])) as string[];
    assert.equal(counters.length, 2);
    for (const counter of counters) {
      assert.match(String(await redis.execute(["GET", counter])), /:3$/);
    }
    assert.equal(
      (await call(first.origin, undefined, { origin: "https://forbidden.test" })).status,
      403,
    );
    await setPartnerKeyPolicy(
      pool,
      key.id,
      { tier: "custom", requestsPerMinute: 3, requestsPerDay: 6 },
      "operator:test",
    );
    assert.equal(
      (await call(second.origin)).status,
      429,
      "Fresh policy and prior usage are shared.",
    );
    await setPartnerKeyPolicy(
      pool,
      key.id,
      { tier: "custom", requestsPerMinute: 5, requestsPerDay: 6 },
      "operator:test",
    );
    assert.equal((await call(relay.origin)).status, 200);
    assert.equal((await call(second.origin)).status, 200);
    assert.equal((await call(first.origin)).status, 429);
    assert.equal(
      (
        await pool.query(
          "SELECT encode(key_hash, 'hex') AS hash FROM partner_api_keys WHERE id=$1",
          [key.id],
        )
      ).rows[0].hash,
      originalHash,
    );
    await revokePartnerApiKey(pool, key.id, "operator:test");
    assert.equal((await call(first.origin)).status, 401);
    assert.equal((await call(relay.origin)).status, 401);

    const concurrent = await issuePartnerApiKey(
      pool,
      "standalone-test",
      "concurrent",
      "operator:test",
    );
    await setPartnerKeyPolicy(
      pool,
      concurrent.id,
      { tier: "custom", requestsPerMinute: 7, requestsPerDay: 20 },
      "operator:test",
    );
    const statuses = await Promise.all(
      Array.from(
        { length: 24 },
        async (_, index) =>
          (
            await fetch((index % 2 ? first.origin : second.origin) + "/api/v1/market/status", {
              headers: { "x-blast-partner-key": concurrent.key },
            })
          ).status,
      ),
    );
    assert.equal(statuses.filter((status) => status === 200).length, 7);
    assert.equal(statuses.filter((status) => status === 429).length, 17);

    const internal = await issuePartnerApiKey(pool, "standalone-test", "internal", "operator:test");
    await setPartnerKeyPolicy(pool, internal.id, { tier: "internal" }, "operator:test");
    const internalHeaders = { "x-blast-partner-key": internal.key };
    assert.equal(
      (await fetch(first.origin + "/api/v1/market/status", { headers: internalHeaders })).status,
      200,
    );
    assert.equal(
      (
        await fetch(first.origin + "/api/v1/market/status", {
          headers: { ...internalHeaders, origin: "https://allowed.test" },
        })
      ).status,
      403,
    );

    const id = "0x" + "a".repeat(64);
    const publicRoutes = [
      "presales?invalid=1",
      "presales/featured",
      `presales/${id}`,
      "prices?invalid=1",
      "discovery?view=hot",
      "search?q=",
      "market/status",
      `market/coins/0x2%3A%3Asui%3A%3ASUI/holders`,
      `market/launches/${id}/activity?view=classified`,
      `market/pools/blast_curve/${id}`,
      `market/pools/cetus/${id}`,
      `market/pools/bluefin/${id}`,
      `market/pools/blast_curve/${id}/candles`,
      `market/pools/cetus/${id}/candles`,
      `market/pools/bluefin/${id}/candles`,
      `market/pools/cetus/${id}/trades`,
      `market/pools/bluefin/${id}/trades`,
      "defillama/metadata",
      "defillama/metrics",
      "defillama/contracts",
    ];
    for (const route of publicRoutes) {
      const response = await fetch(first.origin + "/api/v1/" + route, { headers: internalHeaders });
      assert.equal(
        response.headers.get("x-blast-api-version"),
        "1",
        `Real handler reached for ${route}`,
      );
      assert.ok(
        ![401, 403, 405].includes(response.status),
        `Known public route should reach validation/data for ${route}`,
      );
      await response.body?.cancel();
    }
    const head = await fetch(first.origin + "/api/v1/market/status", {
      method: "HEAD",
      headers: internalHeaders,
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const preflight = await fetch(first.origin + "/api/v1/market/status", {
      method: "OPTIONS",
      headers: {
        origin: "https://allowed.test",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-blast-partner-key",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://allowed.test");
    assert.equal(
      (await fetch(first.origin + "/api/partner/prices", { headers: internalHeaders })).status,
      403,
    );

    const authIpPattern = `${namespace}:*:partner_auth_ip:*`;
    const ipKeysBefore = ((await redis.execute(["KEYS", authIpPattern])) as string[]).length;
    for (const fake of ["198.51.100.14", "203.0.113.16"]) {
      assert.equal(
        (
          await fetch(first.origin + "/api/v1/market/status", {
            headers: { ...internalHeaders, "x-forwarded-for": fake, "x-real-ip": fake },
          })
        ).status,
        200,
      );
    }
    assert.equal(
      ((await redis.execute(["KEYS", authIpPattern])) as string[]).length,
      ipKeysBefore,
      "Untrusted forwarding headers cannot rotate prelookup IP subjects.",
    );

    const atomic = await issuePartnerApiKey(
      pool,
      "standalone-test",
      "atomic-endpoint",
      "operator:test",
    );
    await setPartnerKeyPolicy(
      pool,
      atomic.id,
      { tier: "custom", requestsPerMinute: 1000, requestsPerDay: 1000 },
      "operator:test",
    );

    function counter(
      bucket: keyof typeof DEFAULT_RATE_POLICIES,
      id: string,
      endpoint = false,
    ): string {
      const policy = (endpoint ? PARTNER_ENDPOINT_POLICIES : DEFAULT_RATE_POLICIES)[bucket];
      const subjectHash = createHmac("sha256", environment.RATE_LIMIT_SUBJECT_PEPPER)
        .update(rateLimitSubjectKey(policy, { apiKeyId: id, ip: "127.0.0.1" }))
        .digest("hex");
      return `${namespace}:{partner-quota}:${bucket}:v${policy.version}:${subjectHash}:60`;
    }

    const seconds = Number(((await redis.execute(["TIME"])) as string[])[0]);
    const started = seconds - (seconds % 60);
    await redis.execute([
      "SET",
      counter("launchpad_market_status", atomic.id, true),
      `${started}:120`,
      "EXAT",
      String(started + 60),
    ]);
    assert.equal(
      (
        await fetch(second.origin + "/api/v1/market/status", {
          headers: { "x-blast-partner-key": atomic.key },
        })
      ).status,
      429,
    );
    assert.equal(
      await redis.execute(["GET", counter("partner_read", atomic.id)]),
      null,
      "Endpoint refusal must not spend commercial quota.",
    );

    const protectedPath = INTERNAL_READ_PREFIX + "/api/v1/market/status";
    assert.equal(
      (
        await fetch(first.origin + protectedPath, {
          headers: { "x-blast-internal-user": "forged", authorization: "Bearer forged" },
        })
      ).status,
      403,
    );
    const proofTarget = new Request(first.origin + "/api/v1/market/status", {
      headers: internalHeaders,
    });
    const wrongNamespace = signGatewayRequest(
      proofTarget,
      gatewaySecret,
      "198.51.100.9",
      "a".repeat(64),
    );
    assert.equal((await fetch(proofTarget.url, { headers: wrongNamespace })).status, 403);
    const signed = signGatewayRequest(proofTarget, gatewaySecret, "198.51.100.9", namespace);
    assert.equal((await fetch(proofTarget.url, { headers: signed })).status, 200);
    assert.equal(
      (await fetch(proofTarget.url, { headers: signed })).status,
      403,
      "Gateway nonce replay is refused across replicas.",
    );
    assert.equal(
      (await fetch(second.origin + "/api/v1/market/status", { headers: signed })).status,
      403,
    );

    await redis.execute([
      "SET",
      counter("partner_read_global", atomic.id),
      `${started}:${JSON.parse(recognitionEnvironment.BLAST_PARTNER_CAPACITY_CONFIG).safeRequestsPerMinute - Object.values(JSON.parse(recognitionEnvironment.BLAST_PARTNER_CAPACITY_CONFIG).reserves as Record<string, number>).reduce((sum, number) => sum + number, 0)}`,
      "EXAT",
      String(started + 60),
    ]);
    assert.equal(
      (
        await fetch(first.origin + "/api/v1/market/pools/blast_curve/" + id, {
          headers: { "x-blast-partner-key": atomic.key },
        })
      ).status,
      429,
      "The configured global budget retains its existing counter identity and remains enforced.",
    );
    assert.equal(
      await redis.execute(["GET", counter("partner_read", atomic.id)]),
      null,
      "Global refusal is atomic with the key budget.",
    );
    await redis.execute(["DEL", counter("partner_read_global", atomic.id)]); // Remove only the synthetic exhausted-global fixture.

    const existingAccountId = randomUUID();
    await pool.query(
      "INSERT INTO social_accounts(account_id,privy_did,callsign,display_name) VALUES($1,$2,$3,$4)",
      [existingAccountId, "did:privy:existing-account", "existing_member", "Existing member"],
    );
    const token = await new SignJWT({ sid: "existing-session" })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer("privy.io")
      .setAudience(environment.PRIVY_APP_ID)
      .setSubject("did:privy:existing-account")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(
        await importPKCS8(
          pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          "ES256",
        ),
      );
    const userHeaders = {
      authorization: `Bearer ${token}`,
      origin: "https://frontend.test",
      "sec-fetch-site": "same-origin",
    };
    const accountCount = Number(
      (await pool.query("SELECT count(*) FROM social_accounts")).rows[0].count,
    );
    assert.equal(
      (await fetch(relay.origin + "/api/launchpad/market/status", { headers: userHeaders })).status,
      200,
    );
    const walletToken = "w".repeat(43);
    await pool.query(
      `INSERT INTO social_wallet_sessions (session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at)
    VALUES($1,$2,$3,$4,now(),now()+interval '1 day',now())`,
      [randomUUID(), walletSessionTokenHash(walletToken), "0x" + "a".repeat(64), randomUUID()],
    );
    assert.equal(
      (
        await fetch(relay.origin + "/api/launchpad/market/status", {
          headers: {
            cookie: `__Host-blast_wallet=${walletToken}`,
            origin: "https://frontend.test",
            "sec-fetch-site": "same-origin",
          },
        })
      ).status,
      200,
    );
    assert.equal(
      Number((await pool.query("SELECT count(*) FROM social_accounts")).rows[0].count),
      accountCount,
      "Public reads never create or replace accounts.",
    );
    assert.equal(
      (
        await pool.query("SELECT revoked_at FROM social_wallet_sessions WHERE token_hash=$1", [
          walletSessionTokenHash(walletToken),
        ])
      ).rows[0].revoked_at,
      null,
    );
    assert.equal(
      (
        await fetch(relay.origin + "/api/launchpad/market/status", {
          headers: { cookie: "gate=page-visit-only", "x-blast-internal-user": "forged" },
        })
      ).status,
      200,
    );
    const expiredToken = "e".repeat(43);
    await pool.query(
      `INSERT INTO social_wallet_sessions(session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at)
    VALUES($1,$2,$3,$4,now()-interval '2 days',now()-interval '1 minute',now())`,
      [randomUUID(), walletSessionTokenHash(expiredToken), "0x" + "c".repeat(64), randomUUID()],
    );
    const expiredHeaders = {
      cookie: `__Host-blast_wallet=${expiredToken}`,
      origin: "https://frontend.test",
      "sec-fetch-site": "same-origin",
    };
    const directExpired = new Request(first.origin + protectedPath, { headers: expiredHeaders });
    const expiredDirect = await fetch(directExpired.url, {
      headers: signGatewayRequest(directExpired, gatewaySecret, "198.51.100.10", namespace),
    });
    const expiredRelay = await fetch(relay.origin + "/api/launchpad/market/status", {
      headers: expiredHeaders,
    });
    for (const response of [expiredDirect, expiredRelay]) {
      assert.equal(response.status, 200);
      assert.deepEqual(
        response.headers.getSetCookie(),
        [],
        "Anonymous public reads never inspect or clear wallet sessions.",
      );
    }
    // Exercise the real operator composition without changing existing identities or spending partner quotas.
    const accountBefore = (
      await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [existingAccountId])
    ).rows[0];
    const sessionBefore = (
      await pool.query("SELECT * FROM social_wallet_sessions WHERE token_hash=$1", [
        walletSessionTokenHash(walletToken),
      ])
    ).rows[0];
    const adminPath = "/api/admin/partner-keys";
    const operatorHeaders = { authorization: `Bearer ${adminSecret}` };
    const command = (body: unknown, origin = first.origin) =>
      fetch(origin + adminPath, {
        method: "POST",
        headers: { ...operatorHeaders, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const unauthorizedHeaders: HeadersInit[] = [
      {},
      userHeaders,
      internalHeaders,
      { authorization: `Bearer ${internal.key}` },
    ];
    for (const headers of unauthorizedHeaders) {
      assert.equal(
        (await fetch(first.origin + adminPath, { headers })).status,
        401,
        "Sessions and partner keys cannot authorize operator actions.",
      );
    }
    const forgedAdmin = new Request(first.origin + adminPath, { method: "POST" });
    assert.equal(
      (
        await fetch(forgedAdmin.url, {
          method: "POST",
          headers: signGatewayRequest(forgedAdmin, gatewaySecret, "127.0.0.1", namespace),
        })
      ).status,
      401,
      "A signed first-party read proof grants no operator authority.",
    );
    assert.equal(
      (await command({ action: "create-partner", id: "admin-created", origins: [] })).status,
      200,
    );
    const issuedResponse = await command({
      action: "issue",
      partnerId: "admin-created",
      label: "Elysia operator fixture",
    });
    assert.equal(issuedResponse.status, 200);
    const issued = (await issuedResponse.json()).apiKey as {
      id: string;
      key: string;
      label: string;
    };
    assert.equal(issued.label, "Elysia operator fixture");
    assert.match(issued.key, /^blast_pk_/);
    assert.equal(
      (
        await command({
          action: "set-policy",
          id: issued.id,
          policy: { tier: "custom", requestsPerMinute: 3, requestsPerDay: 10 },
        })
      ).status,
      200,
    );
    const adminIssuedHeaders = { "x-blast-partner-key": issued.key };
    const readAdminKey = (origin: string) =>
      fetch(origin + "/api/v1/market/status", { headers: adminIssuedHeaders });
    assert.equal((await readAdminKey(first.origin)).status, 200);
    const keyHashBefore = (
      await pool.query("SELECT encode(key_hash,'hex') AS hash FROM partner_api_keys WHERE id=$1", [
        issued.id,
      ])
    ).rows[0].hash;
    const quotaKeys = (await redis.execute(["KEYS", `${namespace}:*:partner_read:*`])) as string[];
    const quotaBefore = await Promise.all(
      quotaKeys.map(async (name) => [name, await redis.execute(["GET", name])]),
    );
    assert.equal(
      (
        await command(
          {
            action: "set-policy",
            id: issued.id,
            policy: { tier: "custom", requestsPerMinute: 2, requestsPerDay: 10 },
          },
          second.origin,
        )
      ).status,
      200,
    );
    const listed = await fetch(second.origin + adminPath, { headers: operatorHeaders });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    const listingText = await listed.text();
    assert.ok(listingText.includes("Elysia operator fixture"));
    assert.equal(
      listingText.includes(issued.key),
      false,
      "A key secret appears only in the issue response.",
    );
    for (const [name, value] of quotaBefore) {
      assert.equal(
        await redis.execute(["GET", name as string]),
        value,
        "Operator changes and list requests do not reset or spend quotas.",
      );
    }
    assert.equal(
      (
        await pool.query(
          "SELECT encode(key_hash,'hex') AS hash FROM partner_api_keys WHERE id=$1",
          [issued.id],
        )
      ).rows[0].hash,
      keyHashBefore,
    );
    assert.equal((await readAdminKey(second.origin)).status, 200);
    assert.equal(
      (await readAdminKey(first.origin)).status,
      429,
      "Prior usage survives policy changes across replicas.",
    );
    assert.equal((await command({ action: "revoke", id: issued.id })).status, 200);
    assert.equal(
      (await readAdminKey(second.origin)).status,
      401,
      "Operator revocation is immediately enforced by other replicas.",
    );
    assert.equal(
      (await fetch(first.origin + "/api/admin/presales", { headers: operatorHeaders })).status,
      200,
      "The real SQL-backed presale operator route is mounted.",
    );
    const rewardCoins = await fetch(first.origin + "/api/admin/reward-coins", {
      headers: operatorHeaders,
    });
    assert.equal(
      rewardCoins.status,
      503,
      "The mounted reward route fails closed without a validated deployment manifest in this isolated fixture.",
    );
    assert.equal((await rewardCoins.json()).error.code, "service_unavailable");
    const gas = await fetch(first.origin + "/api/admin/gas-pool/health", {
      headers: operatorHeaders,
    });
    assert.equal(gas.status, 200);
    assert.equal((await gas.json()).up, true, "Gas-pool health uses only the task-owned upstream.");
    assert.deepEqual(
      (await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [existingAccountId]))
        .rows[0],
      accountBefore,
    );
    assert.deepEqual(
      (
        await pool.query("SELECT * FROM social_wallet_sessions WHERE token_hash=$1", [
          walletSessionTokenHash(walletToken),
        ])
      ).rows[0],
      sessionBefore,
    );
    assert.equal(
      (await fetch(relay.origin + "/api/launchpad/market/status", { headers: userHeaders })).status,
      200,
      "The existing session still works after operator changes.",
    );
    assert.equal(
      Number((await pool.query("SELECT count(*) FROM social_accounts")).rows[0].count),
      accountCount,
    );
    await pause(30);
    assert.equal(
      (captured.match(/"caller":"verified_user"/g) ?? []).length,
      0,
      "Public reads do not query optional account/session authentication.",
    );
    assert.match(captured, /anonymous/);
    assert.equal(captured.includes(token), false);
    assert.equal(captured.includes(walletToken), false);
    assert.equal(captured.includes(key.key), false);
    assert.equal(captured.includes(issued.key), false);
    assert.equal(captured.includes(adminSecret), false);

    // Give this short restart/outage phase one stable minute; never renew quota TTLs for the test.
    const remaining = 60 - (Number(((await redis.execute(["TIME"])) as string[])[0]) % 60);
    if (remaining < 35) {
      await pause(remaining * 1_000 + 50);
    }
    const retained = await issuePartnerApiKey(
      pool,
      "standalone-test",
      "restart-stable",
      "operator:test",
    );
    await setPartnerKeyPolicy(
      pool,
      retained.id,
      { tier: "custom", requestsPerMinute: 3, requestsPerDay: 4 },
      "operator:test",
    );
    const retainedRow = (
      await pool.query("SELECT * FROM partner_api_keys WHERE id=$1", [retained.id])
    ).rows;
    const retainedRead = (origin: string) =>
      fetch(origin + "/api/v1/market/status", {
        headers: { "x-blast-partner-key": retained.key },
        signal: AbortSignal.timeout(5_000),
      });
    const commercialKeys = [60, 86_400].map((seconds) =>
      counter("partner_read", retained.id).replace(/:60$/, `:${seconds}`),
    );
    const quotaState = async () =>
      Promise.all(
        commercialKeys.map(async (name) => ({
          name,
          value: await redis.execute(["GET", name]),
          expiresAt: await redis.execute(["EXPIRETIME", name]),
        })),
      );
    assert.equal((await retainedRead(first.origin)).status, 200);
    assert.equal((await retainedRead(second.origin)).status, 200);
    const beforeRestart = await quotaState();
    for (const entry of beforeRestart) {
      assert.match(String(entry.value), /:2$/);
      assert.ok(Number(entry.expiresAt) > 0);
    }
    await stop(second.child);
    second = await start("../src/main.ts");
    assert.deepEqual(
      await quotaState(),
      beforeRestart,
      "Restart must not change namespace, values or expiry.",
    );
    await waitForAdmissionRecovery(() => call(second.origin), 401);
    assert.equal((await retainedRead(second.origin)).status, 200);
    assert.equal((await retainedRead(first.origin)).status, 429);
    const exhausted = await quotaState();
    for (const [index, entry] of exhausted.entries()) {
      assert.match(String(entry.value), /:3$/);
      assert.equal(
        entry.expiresAt,
        beforeRestart[index]!.expiresAt,
        "Reads do not extend the quota window.",
      );
    }
    const postgresQuotas = (
      await pool.query(
        "SELECT * FROM mission_control_rate_limit_windows ORDER BY policy_name, subject_hash, window_seconds",
      )
    ).rows;
    const upstreamBeforeOutage = upstreamReads;
    execFileSync("docker", ["pause", redisContainer!]);
    try {
      for (const origin of [first.origin, second.origin]) {
        const response = await retainedRead(origin);
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, "partner_api_unavailable");
      }
      assert.equal(
        upstreamReads,
        upstreamBeforeOutage,
        "Unavailable admission must not reach data handlers.",
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT * FROM mission_control_rate_limit_windows ORDER BY policy_name, subject_hash, window_seconds",
          )
        ).rows,
        postgresQuotas,
        "Configured Redis failure must not fall back to PostgreSQL allowances.",
      );
    } finally {
      execFileSync("docker", ["unpause", redisContainer!]);
    }
    // Failures may have an unknown acknowledgement; the exhausted key still cannot spend again.
    assert.deepEqual(await quotaState(), exhausted);
    for (const origin of [first.origin, second.origin]) {
      await waitForAdmissionRecovery(() => retainedRead(origin), 429);
    }
    assert.deepEqual(await quotaState(), exhausted);
    assert.deepEqual(
      (await pool.query("SELECT * FROM partner_api_keys WHERE id=$1", [retained.id])).rows,
      retainedRow,
    );
    assert.equal(captured.includes(retained.key), false);
    // Exercise admission and the real market handler together: stub handlers cannot detect
    // an admitted bucket that differs from the handler's prepaid endpoint bucket.
    const catalog = await issuePartnerApiKey(
      pool,
      "standalone-test",
      "market-catalog",
      "operator:test",
    );
    await setPartnerKeyPolicy(
      pool,
      catalog.id,
      { tier: "custom", requestsPerMinute: 100, requestsPerDay: 100 },
      "operator:test",
    );
    const catalogReads = [
      [`/launches/${id}/rewards`, "launchpad_market_rewards"],
      [`/launches/${id}/reward-rounds`, "launchpad_market_reward_rounds"],
      [`/wallets/${id}/launches`, "launchpad_market_wallet_launches"],
      [`/wallets/${id}/launch-rewards`, "launchpad_market_wallet_launch_rewards"],
      [`/wallets/${id}/launch-holder-rewards`, "launchpad_market_wallet_holder_rewards"],
      ["/partners", "launchpad_market_partners"],
      [`/partners/${id}`, "launchpad_market_partner"],
      [`/partners/${id}/launches`, "launchpad_market_partner_launches"],
      ["/launchpad/policy", "launchpad_market_policy"],
    ] as const;

    async function verifyCatalogReads() {
      for (const [suffix, bucket] of catalogReads) {
        for (const method of ["GET", "HEAD"]) {
          for (const [origin, path, headers] of [
            [first.origin, "/api/v1/market" + suffix, { "x-blast-partner-key": catalog.key }],
            [relay.origin, "/api/launchpad/market" + suffix, {}],
          ] as const) {
            const response = await fetch(origin + path, { method, headers });
            assert.equal(response.status, 200, `${method} ${path}`);
            if (method === "GET") {
              assert.deepEqual(await response.json(), { fixture: true });
            } else {
              assert.equal(await response.text(), "");
            }
          }
        }
        assert.match(
          String(await redis.execute(["GET", counter(bucket, catalog.id, true)])),
          /:2$/,
          `${bucket} must be charged exactly once per partner request`,
        );
      }
    }

    await verifyCatalogReads();
    assert.equal(
      await redis.execute(["GET", counter("launchpad_market_pool", catalog.id, true)]),
      null,
      "These routes must never charge the pool bucket",
    );
    assert.match(String(await redis.execute(["GET", counter("partner_read", catalog.id)])), /:18$/);
    assert.equal(captured.includes(catalog.key), false);
    const firstPartyReads = [
      `/creator-claims?recipient=${id}`,
      `/pools/blast_curve/${id}`,
      `/pools/cetus/${id}`,
      `/pools/bluefin/${id}`,
    ];

    async function verifyFirstPartyAndSharedReads() {
      for (const suffix of firstPartyReads) {
        const partnerStatus = suffix.startsWith("/pools/") ? 200 : 403;
        for (const method of ["GET", "HEAD"]) {
          const response = await fetch(relay.origin + "/api/launchpad/market" + suffix, { method });
          assert.equal(response.status, 200, `${method} first-party ${suffix}`);
          if (method === "GET") {
            assert.deepEqual(await response.json(), { fixture: true });
          } else {
            assert.equal(await response.text(), "");
          }
          const partner = await fetch(first.origin + "/api/v1/market" + suffix, {
            method,
            headers: { "x-blast-partner-key": catalog.key },
          });
          assert.equal(partner.status, partnerStatus, `${method} partner ${suffix}`);
          if (partnerStatus === 200 && method === "GET") {
            assert.deepEqual(await partner.json(), { fixture: true });
          } else if (method === "HEAD") {
            assert.equal(await partner.text(), "");
          } else {
            await partner.body?.cancel();
          }
        }
      }
    }

    await verifyFirstPartyAndSharedReads();
    assert.match(
      String(await redis.execute(["GET", counter("launchpad_market_pool", catalog.id, true)])),
      /:6$/,
      "Three venues share the pool bucket, charged once per partner GET/HEAD",
    );
    assert.match(String(await redis.execute(["GET", counter("partner_read", catalog.id)])), /:24$/);
    assert.equal(captured.includes(catalog.key), false);
    t.diagnostic(
      JSON.stringify({
        processes: 3,
        publicRouteBindings: publicRoutes.length,
        atomicEndpointRefusal: true,
        configuredGlobalThrottleSameCounterIdentity: true,
        spoofedIpRefused: true,
        partnerReplicaCalls: statuses.length,
        concurrentAdmitted: 7,
        concurrentRefused: 17,
        freshRevocation: true,
        stableQuotaIdentity: true,
        directRelayExactlyOnce: true,
        sessionKinds: ["privy", "wallet", "anonymous"],
        noAccountCreation: true,
        realAdminCommands: true,
        existingNonNullAccountPreserved: true,
        quotaSurvivesAdminPolicyChange: true,
        publicReadsLeaveExpiredSessionCookiesUntouched: true,
        restrictedRuntimeLogins: true,
        quotaValuesAndExpirySurviveRestart: true,
        revokedKeyStaysRevokedAfterRestart: true,
        redisOutageFailsClosedWithoutPostgresFallback: true,
      }),
    );
  },
);
