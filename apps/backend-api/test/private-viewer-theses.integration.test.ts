import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
import { replicaPooledUrl } from "@blast/core/modules/database/topology.ts";
import {
  FIXTURE_CHECKPOINT,
  FIXTURE_FINGERPRINT,
  urlAs,
} from "../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { freePort, waitForHealth } from "./kit.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../packages/server/test/fixtures/config/runtime-config.ts";

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
  "viewer/theses transport preserves existing accounts and sessions across native Bun replicas without provider work",
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
    await pool.query("UPDATE watermarks SET timestamp_ms_hi_inclusive=$1", [Date.now() - 60_000]);
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
      // The API always checks replica provenance against its deployment: serve the chain fixture's.
      BLAST_DEPLOYMENT_FINGERPRINT: FIXTURE_FINGERPRINT,
      PATH: process.env.PATH,
      NODE_ENV: "test",
      TZ: "UTC",
      DATABASE_URL: database,
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
      DATABASE_REPLICA_URL: urlAs(database, "blast_replica"),
      BLAST_QUOTA_REDIS_URL: redisUrl,
      BLAST_REDIS_NAMESPACE: `private-viewer-theses:${randomUUID()}`,
      BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["private-fixture"]),
      LAUNCHPAD_SUBJECT_PEPPER: "synthetic-launchpad-subject-pepper-0123456789012345",
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
    assert.throws(
      () => replicaPooledUrl({ ...environment, DATABASE_REPLICA_URL: database }),
      /not the primary/,
    );
    assert.equal(replicaPooledUrl(environment), environment.DATABASE_REPLICA_URL);
    const replica = new Pool({
      connectionString: environment.DATABASE_REPLICA_URL,
      max: 1,
    });
    try {
      assert.equal(
        (await replica.query("SELECT current_user AS role")).rows[0].role,
        "blast_replica",
      );
      await replica.query("SELECT presale_id FROM chain_read_v1.presales LIMIT 1");
      await replica.query("SELECT account_id FROM social_accounts LIMIT 1");
    } finally {
      await replica.end();
    }
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
    const cwd = await mkdtemp(join(tmpdir(), "blast-private-viewer-theses-"));
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
          new Request("https://frontend.test/api/" + path, {
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

      const me = await call("social/me");
      assert.equal(me.status, 200, await me.clone().text());
      const identity = await me.json();
      assert.equal(identity.account.account_id, accountId);
      assert.equal(identity.account.callsign, "retained_pilot");
      assert.deepEqual(
        identity.account.wallets.map((wallet: { address: string }) => wallet.address),
        [address],
      );
      const body = JSON.stringify({ presale_ids: ["0x" + "a".repeat(64)] });
      for (const payload of [body, body.padEnd(4096, " ")]) {
        const answer = await call("social/presales/viewer", "POST", payload);
        assert.equal(answer.status, 200, await answer.clone().text());
        assert.equal(answer.headers.get("cache-control"), "private, no-store");
        const result = await answer.json();
        assert.equal(Object.keys(result.presales).length, 1);
        assert.equal(result.presales["0x" + "a".repeat(64)].mine, null);
      }
      const malformed = await call("social/presales/viewer", "POST", "{}");
      assert.equal(malformed.status, 400);
      await malformed.arrayBuffer();
      const partner = await call("social/presales/viewer", "POST", body, {
        "x-blast-partner-key": "synthetic-partner",
      });
      assert.equal(partner.status, 403);
      await partner.arrayBuffer();
      const csrf = await call("social/presales/viewer", "POST", body, {
        origin: "https://wrong.invalid",
      });
      assert.equal(csrf.status, 403);
      await csrf.arrayBuffer();
      const oversized = await call("social/presales/viewer", "POST", body.padEnd(4097, " "));
      assert.equal(oversized.status, 413);
      await oversized.arrayBuffer();
      for (const method of ["GET", "HEAD"]) {
        const answer = await call("launchpad/theses?launchId=" + "0x" + "a".repeat(64), method);
        assert.equal(answer.status, 200, method + ": " + (await answer.clone().text()));
        assert.equal(answer.headers.get("cache-control"), "private, no-store");
        if (method === "HEAD") {
          assert.equal(await answer.text(), "");
        } else {
          const section = (await answer.json()).theses;
          assert.equal(section.state, "stale");
          assert.deepEqual(section.data, { items: [], nextCursor: null });
          assert.equal(section.provenance.source, "replica");
          assert.equal(section.provenance.network, "mainnet");
          assert.equal(section.provenance.deployment, FIXTURE_FINGERPRINT);
          assert.equal(section.provenance.checkpoint, FIXTURE_CHECKPOINT);
        }
      }
      const thesisInput = JSON.stringify({
        input: {
          launchId: "0x" + "a".repeat(64),
          kind: "community_thesis",
          stance: "bullish",
          body: "Synthetic local authentication refusal.",
          evidenceLinks: [],
          disclosure: { text: null, walletAddress: null },
          revisionOf: null,
        },
      });
      const thesisHeaders = {
        origin: "https://frontend.test",
        "content-type": "application/json",
      };
      const missingCsrf = await relay(
        new Request("https://frontend.test/api/launchpad/theses", {
          method: "POST",
          headers: thesisHeaders,
          body: thesisInput,
        }),
      );
      assert.equal(missingCsrf.status, 403);
      assert.equal((await missingCsrf.json()).error.code, "CSRF_INVALID");
      const csrfToken = "c".repeat(43);
      const anon = await relay(
        new Request("https://frontend.test/api/launchpad/theses", {
          method: "POST",
          headers: {
            ...thesisHeaders,
            "sec-fetch-site": "same-origin",
            cookie: `__Host-blast_csrf=${csrfToken}`,
            "x-blast-csrf": csrfToken,
          },
          body: thesisInput,
        }),
      );
      assert.equal(anon.status, 401, await anon.clone().text());
      assert.equal((await anon.json()).error.code, "LAUNCHPAD_AUTH_REQUIRED");
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
      (await pool.query("SELECT count(*)::int AS n FROM social_transactions")).rows[0].n,
      0,
    );
    assert.equal(logs.join("").includes(walletToken), false);
    assert.equal(logs.join("").includes(token), false);
    t.diagnostic(
      "Two native Bun processes, real loopback PG/Valkey and canonical frontend relay. Existing Privy/wallet accounts, links, session, embedded row and commercial counters retained. Viewer200/no-store including exact4096; malformed, CSRF, partner, oversize refused. Empty committed thesis GET/HEAD200 has the exact fixture checkpoint/deployment; anonymous POST401. Successful Privy/WalletProof writes and rollback semantics are covered by original15-case PG suite. No chain/provider requests.",
    );
  },
);
