import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import { gateKeys, requestGateIssuedAt } from "@blast/core/lib/web-security/gate-cookie.ts";
import { parseCoinPageTransfer } from "@blast/core/modules/launchpad-coin/transfer.ts";
import { signPrivateRequest } from "@blast/core/modules/backend-api/private-gateway.ts";
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

async function verifyVestingReads(
  relay: ReturnType<typeof privateBackendRelay>,
  scheduleId: string,
  logs: string[],
) {
  const request = (method: string, path: string) =>
    new Request("https://frontend.test" + path, { method });
  for (const purpose of ["browser", "ssr-read"] as const) {
    const vesting = await relay(request("GET", "/api/vesting/" + scheduleId), purpose);
    assert.equal(
      vesting.status,
      200,
      JSON.stringify({
        body: await vesting.clone().text(),
        backend: logs.join(""),
      }),
    );
    assert.equal(vesting.headers.get("cache-control"), "no-store");
    const detail = (await vesting.json()) as {
      schedule: { schedule_id: string; indexed: boolean };
      events: { event_id: string }[];
    };
    assert.equal(detail.schedule.schedule_id, scheduleId);
    assert.equal(detail.schedule.indexed, true);
    assert.deepEqual(
      detail.events.map((event) => event.event_id),
      ["2:0:0"],
    );
  }
  const vestingHead = await relay(request("HEAD", "/api/vesting/" + scheduleId));
  assert.equal(vestingHead.status, 200);
  assert.equal(await vestingHead.text(), "");
  const invalidVesting = await relay(request("GET", "/api/vesting/invalid"));
  assert.equal(invalidVesting.status, 404);
  assert.equal(
    ((await invalidVesting.json()) as { error: { code: string } }).error.code,
    "not_found",
  );
}

async function verifyCoinAndTelemetry(
  relay: ReturnType<typeof privateBackendRelay>,
  backend: string,
  namespace: string,
  secret: string,
) {
  const launchId = "0x" + "a1".repeat(32);
  const path = "/api/launchpad/coin-page/" + launchId;
  const input = new Request("https://frontend.test" + path);
  assert.equal((await relay(input, "browser")).status, 404);
  const signedBrowser = signPrivateRequest(input, new Uint8Array(), secret, {
    namespace,
    purpose: "ssr-read",
    siteOrigin: "https://frontend.test",
    ip: "192.0.2.1",
  });
  signedBrowser.set("x-blast-private-purpose", "browser");
  const denied = await fetch(backend + path, { headers: signedBrowser });
  assert.equal(denied.status, 403, "A browser-purpose proof cannot access SSR-only reads");
  await denied.body?.cancel();
  const result = await relay(input, "ssr-read");
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  const transfer = parseCoinPageTransfer(await result.text(), launchId);
  assert.equal(transfer.read.kind, "coin");
  // blast-infra is required at boot, so the page always hands the browser the deployment its market reads expect.
  assert.deepEqual(transfer.browserMarket, {
    expected: {
      network: RUNTIME_TEST_ENVIRONMENT.BLAST_NETWORK,
      deployment: RUNTIME_TEST_ENVIRONMENT.BLAST_DEPLOYMENT_FINGERPRINT,
    },
  });
  // BLAST_NETWORK is required at boot too, so the page always links the released deployment's explorer.
  assert.deepEqual(transfer.explorer, {
    environment: "production",
    explorer: { baseUrl: "https://suiscan.xyz/mainnet" },
  });
  assert.equal((await relay(new Request(input, { method: "HEAD" }), "ssr-read")).status, 404);
  for (const path of [
    "/api/launchpad/telemetry",
    "/api/launchpad/outcomes",
    "/api/launchpad/outcomes/commitments",
  ]) {
    const post = (body: string, origin: string) =>
      new Request("https://frontend.test" + path, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body,
      });
    const wrongOrigin = await relay(post("{}", "https://foreign.test"));
    assert.equal(wrongOrigin.status, 403);
    await wrongOrigin.body?.cancel();
    const malformed = await relay(post("{}", "https://frontend.test"));
    assert.equal(malformed.status, 400);
    await malformed.body?.cancel();
    const oversized = await relay(post("x".repeat(1025), "https://frontend.test"));
    assert.equal(oversized.status, 413);
    await oversized.body?.cancel();
  }
}

async function verifyFrontendBootstrap(
  relay: ReturnType<typeof privateBackendRelay>,
  environment: Readonly<Record<string, string | undefined>>,
) {
  const origin = "https://frontend.test";
  const gate = await relay(
    new Request(origin + "/api/gate", { headers: { origin, "sec-fetch-site": "same-origin" } }),
  );
  assert.equal(gate.status, 204);
  assert.equal(gate.headers.get("cache-control"), "no-store");
  const cookie = gate.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  assert.notEqual(
    requestGateIssuedAt(new Request(origin, { headers: { cookie } }), gateKeys(environment)!),
    null,
    "frontend validates cookie minted in independent Bun process",
  );
  assert.equal(
    (
      await relay(
        new Request(origin + "/api/gate", {
          headers: { origin: "https://foreign.test", "sec-fetch-site": "same-origin" },
        }),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await relay(
        new Request(origin + "/api/gate", { headers: { origin, "sec-fetch-site": "cross-site" } }),
      )
    ).status,
    403,
  );
  for (const method of ["HEAD", "POST"]) {
    assert.equal((await relay(new Request(origin + "/api/gate", { method }))).status, 404);
  }
  assert.equal((await relay(new Request(origin + "/api/gate"), "ssr-read")).status, 404);
  assert.equal(
    (await relay(new Request(origin + "/api/team-access", { method: "POST" }))).status,
    404,
  );
}

test(
  "real primary accounts, Privy and wallet sessions survive private Bun reads across replicas",
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
    const scheduleId = "0x" + "b".repeat(64);
    await pool.query(
      `INSERT INTO watermarks SELECT 'vesting',epoch_hi_inclusive,checkpoint_hi_inclusive,tx_hi,timestamp_ms_hi_inclusive,reader_lo,pruner_timestamp,pruner_hi,chain_id FROM watermarks WHERE pipeline='intake'`,
    );
    await pool.query(
      `INSERT INTO utility_vesting_schedules(schedule_id,kind,coin_type,beneficiary,creator,total,terms,created_checkpoint,created_timestamp_ms,created_digest,applied_checkpoint)
      VALUES($1,'linear','0x2::sui::SUI',$1,$1,100,'{"start_ms":"0","cliff_ms":"0","period_ms":"1","periods":"100"}',1,1,'synthetic',2)`,
      [scheduleId],
    );
    await pool.query(
      `INSERT INTO utility_vesting_events(checkpoint,tx_slot,event_slot,schedule_id,kind,timestamp_ms,digest,payload)
      VALUES(2,0,0,$1,'created',2,'synthetic','{}'),(3,0,0,$1,'claimed',3,'synthetic','{}')`,
      [scheduleId],
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
    await pool.query("INSERT INTO presale_embedded_wallets(privy_did,address) VALUES($1,$2)", [
      "did:privy:retained-pilot",
      address,
    ]);
    const beforeEmbedded = (await pool.query("SELECT * FROM presale_embedded_wallets")).rows;
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
      BLAST_GATE_SECRET: "synthetic-gate-shared-key-01234567890123456789",
      // Fresh launch reads go to a loopback port nothing listens on, never the public fullnode.
      PRESALE_SUI_GRPC_URL: `https://127.0.0.1:${await freePort()}`,
      DATABASE_URL: database,
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
      DATABASE_REPLICA_URL: localReplicaUrl(database),
      BLAST_QUOTA_REDIS_URL: redisUrl,
      BLAST_REDIS_NAMESPACE: `private-identity:${randomUUID()}`,
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
    const cwd = await mkdtemp(join(tmpdir(), "blast-private-identity-"));
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
    const request = (headers: Record<string, string>, method = "GET", path = "/api/social/me") =>
      new Request("https://frontend.test" + path, {
        method,
        headers: {
          origin: "https://frontend.test",
          "sec-fetch-site": "same-origin",
          ...headers,
        },
      });
    for (const backend of origins) {
      const relay = privateBackendRelay(
        parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: backend }),
        { clientAddress: () => "192.0.2.1" },
      );
      await verifyFrontendBootstrap(
        privateBackendRelay(
          parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: backend }),
          { clientAddress: () => "192.0.2." + (60 + origins.indexOf(backend)) },
        ),
        environment,
      );
      await verifyVestingReads(relay, scheduleId, logs);
      await verifyCoinAndTelemetry(
        relay,
        backend,
        namespace,
        environment.BLAST_BACKEND_GATEWAY_SECRET,
      );
      for (const headers of [
        { authorization: `Bearer ${token}` },
        { cookie: `__Host-blast_wallet=${walletToken}` },
      ] as Record<string, string>[]) {
        const response = await relay(request(headers));
        assert.equal(response.status, 200);
        const result = (await response.json()) as {
          account: {
            account_id: string;
            callsign: string;
            wallets: { address: string }[];
          };
        };
        assert.equal(result.account.account_id, accountId);
        assert.equal(result.account.callsign, "retained_pilot");
        assert.deepEqual(
          result.account.wallets.map((wallet) => wallet.address),
          [address],
        );
        assert.deepEqual(response.headers.getSetCookie(), []);
      }
      const privyHeaders = { authorization: `Bearer ${token}` };
      const settings = await relay(request(privyHeaders, "GET", "/api/account/settings"));
      assert.equal(settings.status, 200);
      const expected =
        backend === origins[0]
          ? { explorer: "suivision", theme: "system", saved: false }
          : { explorer: "suiscan", theme: "dark", saved: true };
      assert.deepEqual(await settings.json(), expected);
      if (backend === origins[0]) {
        const json = JSON.stringify({ explorer: "suiscan", theme: "dark" });
        const put = await relay(
          new Request("https://frontend.test/api/account/settings", {
            method: "PUT",
            headers: {
              ...privyHeaders,
              origin: "https://frontend.test",
              "content-type": "application/json; charset=UTF-8",
            },
            body: json + " ".repeat(65_536 - Buffer.byteLength(json)),
          }),
        );
        assert.equal(put.status, 200, "Exact64KiB reaches unchanged JSON parser");
        assert.deepEqual(await put.json(), {
          explorer: "suiscan",
          theme: "dark",
          saved: true,
        });
        const over = await relay(
          new Request("https://frontend.test/api/account/settings", {
            method: "PUT",
            headers: privyHeaders,
            body: new Uint8Array(65_537),
          }),
        );
        assert.equal(over.status, 413);
      }
      const wallets = await relay(request(privyHeaders, "GET", "/api/account/wallets"));
      assert.equal(wallets.status, 200);
      assert.deepEqual(await wallets.json(), {
        wallets: [{ address, kind: "embedded", primary: true }],
      });
      for (const path of ["/api/account/settings", "/api/account/wallets"]) {
        const headAccount = await relay(request(privyHeaders, "HEAD", path));
        assert.equal(headAccount.status, 200);
        assert.equal(await headAccount.text(), "");
        const walletOnly = await relay(
          request({ cookie: `__Host-blast_wallet=${walletToken}` }, "GET", path),
        );
        assert.equal(walletOnly.status, 401, "Presale account auth remains Privy DID only");
        const keyOnly = await relay(
          request({ "x-blast-api-key": "synthetic-no-authority" }, "GET", path),
        );
        assert.equal(keyOnly.status, 401);
      }
      const expired = await relay(request({ cookie: `__Host-blast_wallet=${expiredToken}` }));
      assert.equal(expired.status, 401);
      assert.equal(expired.headers.getSetCookie().length, 2);
      for (const cookie of expired.headers.getSetCookie()) {
        assert.match(cookie, /Path=\/; Max-Age=0;.*Secure; SameSite=Strict/);
      }
      const head = await relay(request({ cookie: `__Host-blast_wallet=${walletToken}` }, "HEAD"));
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    assert.deepEqual(
      (await pool.query("SELECT * FROM presale_embedded_wallets")).rows,
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
    assert.equal(
      (await pool.query("SELECT count(*)::int AS count FROM social_accounts")).rows[0].count,
      1,
    );
    assert.equal(logs.join("").includes(walletToken), false);
    assert.equal(logs.join("").includes(token), false);
    t.diagnostic(
      "Two actual Bun processes + loopback PostgreSQL/Redis; exact existing account/link/session/counter parity; no provider or chain calls.",
    );
  },
);
