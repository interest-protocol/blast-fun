import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SignJWT, importPKCS8 } from "jose";
import { Pool } from "pg";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import {
  RedisRateLimitEnforcer,
  quotaNamespace,
} from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { freePort, waitForHealth } from "./kit.ts";
import {
  localReplicaUrl,
  RUNTIME_TEST_ENVIRONMENT,
} from "../../../packages/server/test/fixtures/config/runtime-config.ts";

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await closed;
  clearTimeout(deadline);
}

test(
  "personal financial transports preserve sessions and commercial counters across native Bun replicas",
  { timeout: 90_000 },
  async (t) => {
    const database = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
    const redisUrl = process.env.BLAST_TEST_REDIS_URL;
    assert.ok(
      database && redisUrl,
      "Disposable loopback PostgreSQL and Redis are required; never skip.",
    );
    for (const value of [database, redisUrl]) {
      assert.equal(new URL(value).hostname, "127.0.0.1");
    }
    const pool = new Pool({ connectionString: database, max: 2 });
    const redis = createRedisConnection(redisUrl, "quota");
    t.after(async () => {
      redis.close();
      await pool.end();
    });
    await migrateDatabase(pool);
    await pool.query(
      await readFile(new URL("./vesting-read-fixture.sql", import.meta.url), "utf8"),
    );
    await pool.query(
      `INSERT INTO watermarks SELECT 'vesting',epoch_hi_inclusive,checkpoint_hi_inclusive,tx_hi,timestamp_ms_hi_inclusive,reader_lo,pruner_timestamp,pruner_hi,chain_id FROM watermarks WHERE pipeline='intake'`,
    );
    const accountId = randomUUID();
    const address = "0x" + "a".repeat(64);
    const walletToken = "w".repeat(43);
    const expiredToken = "e".repeat(43);
    await pool.query(
      "INSERT INTO social_accounts(account_id, privy_did, callsign, display_name) VALUES($1,$2,'retained_pilot','Retained pilot')",
      [accountId, "did:privy:retained-pilot"],
    );
    await pool.query(
      "INSERT INTO social_account_wallets(address,account_id,kind,verified_at) VALUES($1,$2,'slush',now())",
      [address, accountId],
    );
    for (const [token, expired] of [
      [walletToken, false],
      [expiredToken, true],
    ] as const) {
      await pool.query(
        `INSERT INTO social_wallet_sessions(session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at)
      VALUES($1,$2,$3,$4,now()-CASE WHEN $5 THEN interval '2 days' ELSE interval '0' END,now()+CASE WHEN $5 THEN interval '-1 minute' ELSE interval '1 day' END,now()-CASE WHEN $5 THEN interval '2 hours' ELSE interval '0' END)`,
        [randomUUID(), walletSessionTokenHash(token), address, randomUUID(), expired],
      );
    }
    await pool.query(
      "UPDATE social_accounts SET onboarding_shown_at=now(), onboarded_at=now(), default_follows_applied_at=now(), launch_code_follow_applied_at=now() WHERE account_id=$1",
      [accountId],
    );
    await pool.query("INSERT INTO presale_embedded_wallets(privy_did,address) VALUES($1,$2)", [
      "did:privy:retained-pilot",
      address,
    ]);
    const beforeEmbedded = (
      await pool.query("SELECT * FROM presale_embedded_wallets ORDER BY privy_did")
    ).rows;
    const beforeAccount = (
      await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [accountId])
    ).rows[0];
    const beforeWallets = (
      await pool.query(
        "SELECT * FROM social_account_wallets WHERE account_id=$1 ORDER BY address",
        [accountId],
      )
    ).rows;
    const beforeSession = (
      await pool.query("SELECT * FROM social_wallet_sessions WHERE token_hash=$1", [
        walletSessionTokenHash(walletToken),
      ])
    ).rows[0];
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const environment = {
      ...RUNTIME_TEST_ENVIRONMENT,
      PATH: process.env.PATH,
      NODE_ENV: "test",
      TZ: "UTC",
      DATABASE_URL: database,
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
      DATABASE_REPLICA_URL: localReplicaUrl(database),
      BLAST_QUOTA_REDIS_URL: redisUrl,
      BLAST_REDIS_NAMESPACE: `private-financial:${randomUUID()}`,
      BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["private-fixture"]),
      RATE_LIMIT_SUBJECT_PEPPER: "synthetic-private-subject-pepper-01234567890123456789",
      BLAST_BACKEND_GATEWAY_SECRET: "synthetic-private-gateway-secret-01234567890123456789",
      BLAST_BACKEND_INGRESS_MODE: "direct",
      BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
      NEXT_PUBLIC_SITE_URL: "https://frontend.test",
      PRIVY_APP_ID: "retained-existing-app",
      PRIVY_JWT_VERIFICATION_KEY: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      BLAST_DEPLOYMENT_TARGET: "preview",
      BLAST_DEPLOYMENT_BRANCH: "private-local-fixture",
    };
    const namespace = quotaNamespace(
      environment.BLAST_REDIS_NAMESPACE,
      deploymentIdentity(environment),
    );
    await new RedisRateLimitEnforcer({
      redis,
      namespace,
      subjectPepper: environment.RATE_LIMIT_SUBJECT_PEPPER,
    }).consume("partner_read", { apiKeyId: randomUUID() });
    const paidKeys = (await redis.execute(["KEYS", `${namespace}:*:partner_read:*`])) as string[];
    // Synthetic sentinels must survive a minute boundary; production TTLs have separate tests.
    await Promise.all(paidKeys.map((key) => redis.execute(["PEXPIRE", key, "120000"])));
    const paidBefore = await Promise.all(paidKeys.map((key) => redis.execute(["GET", key])));
    assert.equal(paidKeys.length, 2);
    const cwd = await mkdtemp(join(tmpdir(), "blast-private-financial-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const logs: string[] = [];

    async function start() {
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [
          "--no-env-file",
          "--preload",
          new URL("./loopback-fetch-only.ts", import.meta.url).pathname,
          new URL("../src/main.ts", import.meta.url).pathname,
        ],
        {
          cwd,
          env: { ...environment, PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout!.on("data", (data) => {
        logs.push(data.toString());
      });
      child.stderr!.on("data", (data) => {
        logs.push(data.toString());
      });
      t.after(() => stop(child));
      const origin = `http://127.0.0.1:${port}`;
      return waitForHealth(child, origin, 40_000);
    }

    const origins = [await start(), await start()];
    const token = await new SignJWT({ sid: "retained-session" })
      .setProtectedHeader({ alg: "ES256" })
      .setSubject("did:privy:retained-pilot")
      .setIssuer("privy.io")
      .setAudience(environment.PRIVY_APP_ID)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(
        await importPKCS8(
          keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          "ES256",
        ),
      );
    const identityHeaders = [
      { authorization: `Bearer ${token}` },
      { cookie: `__Host-blast_wallet=${walletToken}` },
    ] as Record<string, string>[];
    for (const [index, backend] of origins.entries()) {
      const relay = privateBackendRelay(
        parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: backend }),
        { clientAddress: () => "192.0.2.1" },
      );

      async function call(
        path: string,
        method = "GET",
        body?: string,
        extra: Record<string, string> = {},
      ) {
        return relay(
          new Request("https://frontend.test/api/social/" + path, {
            method,
            headers: {
              origin: "https://frontend.test",
              "sec-fetch-site": "same-origin",
              ...identityHeaders[index],
              ...(body === undefined ? {} : { "content-type": "application/json" }),
              ...extra,
            },
            ...(body === undefined ? {} : { body }),
          }),
        );
      }

      const missing = randomUUID();
      const list = await call("me/vesting");
      assert.equal(list.status, 200, await list.clone().text());
      assert.deepEqual(await list.json(), { wallet: address, schedules: [] });
      const quote = await call("me/bridge-withdrawals/quote");
      assert.equal(quote.status, 200, await quote.clone().text());
      const quoted = await quote.json();
      assert.equal(quoted.destinations.length, 4);
      assert.ok(
        quoted.destinations.every((entry: { available: boolean }) => entry.available === false),
      );
      for (const [path, method, body, status] of [
        [`me/vesting/attempts/${missing}`, "GET", undefined, 404],
        [`me/vesting/attempts/${missing}`, "PUT", "{}", 400],
        ["me/bridge-withdrawals", "POST", "{}", 400],
        [`me/bridge-withdrawals/${missing}/settle`, "POST", undefined, 404],
      ] as const) {
        const answer = await call(path, method, body);
        assert.equal(answer.status, status, `${method} ${path}: ${await answer.clone().text()}`);
        await answer.arrayBuffer();
      }
      for (const [path, status] of [
        ["me/vesting", 200],
        ["me/bridge-withdrawals/quote", 200],
        [`me/vesting/attempts/${missing}`, 404],
      ] as const) {
        const answer = await call(path, "HEAD");
        assert.equal(answer.status, status);
        assert.equal(await answer.text(), "");
      }
      for (const path of ["me/vesting", "me/bridge-withdrawals/quote"]) {
        const answer = await call(path, "GET", undefined, {
          "x-blast-partner-key": "synthetic-partner",
        });
        assert.equal(answer.status, 403);
        await answer.arrayBuffer();
      }
      const csrf = await call("me/bridge-withdrawals", "POST", "{}", {
        origin: "https://wrong.invalid",
      });
      assert.equal(csrf.status, 403);
      await csrf.arrayBuffer();
      const oversized = await call(`me/vesting/attempts/${missing}`, "PUT", " ".repeat(65537));
      assert.equal(oversized.status, 413);
      await oversized.arrayBuffer();
    }
    assert.deepEqual(
      (await pool.query("SELECT * FROM presale_embedded_wallets ORDER BY privy_did")).rows,
      beforeEmbedded,
    );
    assert.deepEqual(
      (await pool.query("SELECT * FROM social_accounts WHERE account_id=$1", [accountId])).rows[0],
      beforeAccount,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT * FROM social_account_wallets WHERE account_id=$1 ORDER BY address",
          [accountId],
        )
      ).rows,
      beforeWallets,
    );
    assert.deepEqual(
      (
        await pool.query("SELECT * FROM social_wallet_sessions WHERE token_hash=$1", [
          walletSessionTokenHash(walletToken),
        ])
      ).rows[0],
      beforeSession,
    );
    assert.deepEqual(
      await Promise.all(paidKeys.map((key) => redis.execute(["GET", key]))),
      paidBefore,
    );
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM social_accounts")).rows[0].n, 1);
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM social_vesting_attempts")).rows[0].n,
      0,
    );
    assert.equal(
      (await pool.query("SELECT count(*)::int AS n FROM social_bridge_withdrawals")).rows[0].n,
      0,
    );
    assert.equal(logs.join("").includes(walletToken), false);
    assert.equal(logs.join("").includes(token), false);
    t.diagnostic(
      "Two real Bun main processes, loopback PostgreSQL/Valkey, six financial methods plus HEAD/auth/CSRF/body parity and exact account/session/commercial counters. Empty indexed vesting and disabled bridge quote succeed; mutation refusals preserve empty rows. Successful transaction preparation/settlement is covered separately by the existing vesting sponsorship and withdrawal DB suites with fixture providers; no external or chain calls.",
    );
  },
);
