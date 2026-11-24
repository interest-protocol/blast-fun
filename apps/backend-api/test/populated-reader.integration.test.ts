import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { importPKCS8, SignJWT } from "jose";
import { Pool } from "pg";
import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { configuredRedis, createRedisConnection } from "@blast/core/lib/redis.ts";
import { quotaNamespace } from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { signGatewayRequest } from "@blast/core/modules/backend-api/gateway.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import {
  createPartner,
  issuePartnerApiKey,
  revokePartnerApiKey,
  setPartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/repository.ts";
import {
  v1PresaleDetail,
  v1PresaleSummaries,
} from "@blast/server/modules/partner-api/v1/presales.ts";
import { freshTestDatabase } from "../../../packages/core/test/fixtures/modules/database/template.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../packages/server/test/fixtures/config/runtime-config.ts";
import { capacityFixture } from "./capacity-fixture.ts";
import { freePort } from "./kit.ts";
import { mixedReadProfile } from "./mixed-read-profile.ts";
import { runtimeRoleFixture } from "./partner-verifier-fixture.ts";
import { populatedReaderBinding, readPopulatedReaderFixture } from "./populated-reader-fixture.ts";
import { backendConfig } from "../src/app/api/config.ts";

type Body = Record<string, unknown>;
type RouteTotals = {
  attempts: number;
  valid: number;
  statuses: Record<string, number>;
  errors: Record<string, number>;
};

function object(value: unknown): Body {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Body;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function committedBody(body: Body): Body {
  if (!body.provenance) {
    return body;
  }
  const committed = Object.fromEntries(
    Object.entries(object(body.provenance)).filter(
      ([key]) => !["observed_ms", "lag_ms"].includes(key),
    ),
  );
  return { ...body, provenance: committed };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const deadline = setTimeout(() => child.kill("SIGKILL"), 3_000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}

/** Definitions, owner/grants and actual committed rows; no clock-dependent observation field. */
async function nativeFingerprint(pool: Pool, sale: string): Promise<string> {
  const views = await pool.query(`SELECT c.relname,pg_get_viewdef(c.oid,true) AS definition,
    pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS grants
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='chain_read_v1' AND c.relkind='v' ORDER BY c.relname`);
  const facts = await pool.query(
    `SELECT
    (SELECT jsonb_agg(to_jsonb(p)) FROM chain_read_v1.presales p WHERE presale_id=$1) AS sales,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY wallet) FROM chain_read_v1.presale_positions p WHERE presale_id=$1) AS positions,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY activity_id) FROM chain_read_v1.activity a WHERE presale_id=$1) AS activity,
    (SELECT to_jsonb(w)-'observed_ms'-'lag_ms' FROM chain_read_v1.watermark w) AS watermark`,
    [sale],
  );
  assert.ok(array(facts.rows[0].sales).length > 0 && array(facts.rows[0].positions).length > 0);
  return digest([views.rows, facts.rows]);
}

async function retainedIdentity(pool: Pool): Promise<unknown> {
  const snapshots = [];
  for (const table of [
    "social_accounts",
    "social_account_wallets",
    "social_wallet_sessions",
    "presale_embedded_wallets",
  ]) {
    snapshots.push(
      (await pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`))
        .rows,
    );
  }
  return snapshots;
}

function restoreEnvironment(prior: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

const profileSetting = process.env.BLAST_POPULATED_READER_PROFILE_MS;
assert.ok(
  profileSetting === undefined || profileSetting === "120000",
  "Profile must be explicitly set to 120000 ms.",
);
const profileMs = profileSetting === "120000" ? 120_000 : 0;

function assertProfileDay() {
  if (!profileMs) {
    return;
  }
  const now = new Date();
  const nextUtcDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  assert.ok(
    nextUtcDay - now.getTime() > 300_000,
    "The populated profile requires at least five minutes before UTC midnight.",
  );
}

// Fails if native amounts, IDs or catalog membership change through admission, or reads mutate identity/quota ownership.
test(
  "populated native presale detail and catalog variants preserve bodies, quotas and identities through real transports",
  { timeout: profileMs ? 240_000 : 120_000 },
  async () => {
    assertProfileDay();
    const started = performance.now();
    const fixture = readPopulatedReaderFixture(
      process.env.BLAST_POPULATED_FIXTURE_READY,
      populatedReaderBinding(process.env),
    );
    const reportPath = process.env.BLAST_POPULATED_FIXTURE_RESULT;
    const infraKey = process.env.BLAST_BACKEND_READER_TEST_API_KEY;
    const nativeBase = process.env.BLAST_POPULATED_FIXTURE_DATABASE_URL;
    const redisUrl = process.env.BLAST_TEST_REDIS_URL;
    assert.ok(reportPath && infraKey && nativeBase && redisUrl);
    const report = {
      requests: 0,
      errors: 0,
      complete: false,
      passed: false,
      phase: "native-migrations",
      startup_diagnostic: "",
      events: [] as { label: string; status: number | null }[],
      native_chain_before_sha256: "",
      native_chain_after_sha256: "",
      matrix_elapsed_ms: 0,
      quota_window: null as null | { started_ms: number; expires_ms: number; wait_ms: number },
      quota_observations: [] as {
        label: string;
        before_ms: number;
        after_ms: number;
        entries: { key: string; value: string; ttl_ms: number; expires_ms: number }[];
      }[],
      catalog_matrix: {
        elapsed_ms: 0,
        calls: [] as {
          id: string;
          transport: string;
          elapsed_ms: number;
          expected_delta: number;
          before_count: number;
          after_count: number | null;
          daily_owner: string;
        }[],
      },
      elapsed_ms: 0,
      sustained_profile: null as null | {
        profile: Awaited<ReturnType<typeof mixedReadProfile>>;
        completed: Record<string, number>;
        resources: Record<string, { cpuTicks: number; peakRssKiB: number }>;
        routes: Record<string, Record<string, RouteTotals>>;
        matrixPartnerReads: number;
        samples: number;
        samplingFailed: boolean;
        scope: string;
      },
      scope: `actual native chain_read_v1 SQL plus native HTTP terms; public presale detail and catalog variants; ${fixture.producer_mode}; synthetic archival fixture`,
    };
    const save = () =>
      writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    save();
    const children: ChildProcess[] = [];
    const cleanups: (() => Promise<void>)[] = [];
    const roleCleanup = { after: (cleanup: () => Promise<void>) => cleanups.push(cleanup) };
    const nativeUrl = new URL(nativeBase);
    nativeUrl.pathname = `/${fixture.database_name}`;
    const native = new Pool({ connectionString: nativeUrl.toString(), max: 1 });
    let product: Pool | undefined;
    let dropProduct: (() => Promise<void>) | undefined;
    const redis = createRedisConnection(redisUrl, "quota");
    const prior: Record<string, string | undefined> = {};
    let logs = "";

    /** Counts all consumer HTTP calls, including readiness, expected refusals and connection errors. */
    async function call(
      label: string,
      origin: string,
      path: string,
      headers: HeadersInit = {},
    ): Promise<Response> {
      report.requests++;
      const event = { label, status: null as number | null };
      report.events.push(event);
      save();
      try {
        const response = await fetch(origin + path, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(5_000),
        });
        event.status = response.status;
        if (!response.ok) {
          report.errors++;
        }
        save();
        return response;
      } catch {
        report.errors++;
        save();
        throw new Error(`Synthetic ${label} request did not complete.`);
      }
    }

    async function json(
      label: string,
      origin: string,
      path: string,
      headers: HeadersInit = {},
    ): Promise<Body> {
      const response = await call(label, origin, path, headers);
      assert.equal(response.status, 200, label);
      assert.equal(
        response.headers.get("set-cookie"),
        null,
        "Public reads must not create or refresh sessions.",
      );
      return object(await response.json());
    }

    async function quotaTime(): Promise<number> {
      const clock = array(await redis.execute(["TIME"]));
      assert.equal(clock.length, 2);
      assert.ok(clock.every((value) => typeof value === "string" && /^[0-9]+$/.test(value)));
      const milliseconds = Number(clock[0]) * 1_000 + Math.floor(Number(clock[1]) / 1_000);
      assert.ok(Number.isSafeInteger(milliseconds));
      return milliseconds;
    }

    async function fenceQuotaWindow(): Promise<void> {
      const fenceStarted = performance.now();
      const fenceDeadline = fenceStarted + 51_000;
      while (true) {
        assert.ok(
          performance.now() < fenceDeadline,
          "Redis quota window wait exceeded 51 seconds.",
        );
        const now = await quotaTime();
        const remaining = 60_000 - (now % 60_000);
        if (remaining >= 50_000) {
          report.quota_window = {
            started_ms: now,
            expires_ms: now + remaining,
            wait_ms: Math.ceil(performance.now() - fenceStarted),
          };
          save();
          break;
        }
        await pause(Math.min(remaining + 25, fenceDeadline - performance.now()));
      }
    }

    function assertQuotaWindow(milliseconds: number): void {
      assert.ok(report.quota_window);
      assert.ok(
        milliseconds >= report.quota_window.started_ms &&
          milliseconds < report.quota_window.expires_ms,
        "Finite quota observations must stay inside the fenced Redis minute.",
      );
    }

    async function observeCounters(
      label: string,
      pattern: string,
    ): Promise<Record<string, string>> {
      const before = await quotaTime();
      assertQuotaWindow(before);
      const keys = (await redis.execute(["KEYS", pattern])) as string[];
      const entries = await Promise.all(
        keys.sort().map(async (key) => ({
          key,
          value: String(await redis.execute(["GET", key])),
          ttl_ms: Number(await redis.execute(["PTTL", key])),
          expires_ms: Number(await redis.execute(["PEXPIRETIME", key])),
        })),
      );
      const after = await quotaTime();
      report.quota_observations.push({ label, before_ms: before, after_ms: after, entries });
      save();
      assertQuotaWindow(after);
      return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
    }

    try {
      report.native_chain_before_sha256 = await nativeFingerprint(native, fixture.ids.presale_id);
      await migrateDatabase(native);
      report.native_chain_after_sha256 = await nativeFingerprint(native, fixture.ids.presale_id);
      assert.equal(
        report.native_chain_after_sha256,
        report.native_chain_before_sha256,
        "Existing product migrations must preserve native facts and chain view definitions/ownership/grants.",
      );
      report.phase = "product-identity";
      save();
      const database = await freshTestDatabase();
      dropProduct = database.drop;
      const productUrl = new URL(database.url);
      assert.equal(productUrl.hostname, "127.0.0.1");
      assert.notEqual(
        productUrl.port,
        nativeUrl.port,
        "Primary and native replica use separate owned servers.",
      );
      const cloneName = productUrl.pathname.slice(1);
      assert.match(cloneName, /^test_[0-9]+_[0-9]+_[0-9a-f]+$/);
      const maintenanceUrl = new URL(productUrl);
      maintenanceUrl.pathname = "/postgres";
      const rename = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
      try {
        // Real runtime topology requires one logical database name on both physical endpoints.
        await rename.query(`ALTER DATABASE ${cloneName} RENAME TO ${fixture.database_name}`);
      } finally {
        await rename.end();
      }
      productUrl.pathname = nativeUrl.pathname;
      const productDatabaseUrl = productUrl.toString();
      dropProduct = async () => {
        const cleanup = new Pool({ connectionString: maintenanceUrl.toString(), max: 1 });
        try {
          await cleanup.query(`DROP DATABASE IF EXISTS ${fixture.database_name} WITH (FORCE)`);
        } finally {
          await cleanup.end();
        }
        await database.drop();
      };
      product = new Pool({ connectionString: productDatabaseUrl, max: 1 });
      const accountId = randomUUID();
      const did = "did:privy:populated-existing";
      await product.query(
        "INSERT INTO social_accounts(account_id,privy_did,callsign,display_name) VALUES($1,$2,'populated_pilot','Existing pilot')",
        [accountId, did],
      );
      await product.query(
        "INSERT INTO social_account_wallets(address,account_id,kind,verified_at) VALUES($1,$2,'slush',now())",
        [fixture.ids.wallet, accountId],
      );
      const walletToken = "w".repeat(43);
      await product.query(
        `INSERT INTO social_wallet_sessions(session_id,token_hash,wallet_address,challenge_id,created_at,expires_at,last_used_at)
      VALUES($1,$2,$3,$4,now(),now()+interval '1 day',now())`,
        [randomUUID(), walletSessionTokenHash(walletToken), fixture.ids.wallet, randomUUID()],
      );
      await product.query("INSERT INTO presale_embedded_wallets(privy_did,address) VALUES($1,$2)", [
        did,
        fixture.ids.wallet,
      ]);
      const identity = await retainedIdentity(product);
      const recognition = {
        BLAST_QUOTA_REDIS_URL: redisUrl,
        BLAST_REDIS_NAMESPACE: `populated:${randomUUID()}`,
        BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["populated-reader", "populated-capacity"]),
        RATE_LIMIT_SUBJECT_PEPPER: "synthetic-populated-pepper-012345678901234567890123456789",
        BLAST_DEPLOYMENT_TARGET: "preview",
        BLAST_DEPLOYMENT_BRANCH: "populated-reader",
      };
      for (const key of Object.keys(recognition)) {
        prior[key] = process.env[key];
      }
      Object.assign(process.env, recognition);
      report.phase = "partner-policy";
      save();
      await createPartner(product, { id: "populated-reader", origins: [] }, "operator:test");
      const partner = await issuePartnerApiKey(
        product,
        "populated-reader",
        "native-populated",
        "operator:test",
      );
      await setPartnerKeyPolicy(
        product,
        partner.id,
        { tier: "custom", requestsPerMinute: 2, requestsPerDay: 2 },
        "operator:test",
      );
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
      report.phase = "runtime-roles";
      save();
      const environment = {
        ...RUNTIME_TEST_ENVIRONMENT,
        PATH: process.env.PATH,
        TZ: "UTC",
        NODE_ENV: "test",
        ...recognition,
        BLAST_NETWORK: fixture.network,
        BLAST_DEPLOYMENT_FINGERPRINT: fixture.deployment_fingerprint,
        DATABASE_URL: await runtimeRoleFixture(productDatabaseUrl, roleCleanup, "blast_web"),
        DATABASE_REPLICA_URL: await runtimeRoleFixture(
          nativeUrl.toString(),
          roleCleanup,
          "blast_replica",
        ),
        PARTNER_VERIFIER_DATABASE_URL: await runtimeRoleFixture(
          productDatabaseUrl,
          roleCleanup,
          "blast_partner_verifier",
        ),
        DATABASE_POOL_MAX: "1",
        DATABASE_REPLICA_POOL_MAX: "2",
        BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
        BLAST_BACKEND_INGRESS_MODE: "direct",
        BLAST_BACKEND_GATEWAY_SECRET: "synthetic-populated-gateway-01234567890123456789",
        BLAST_INFRA_ORIGIN: fixture.writer_origin,
        BLAST_INFRA_READ_ORIGIN: fixture.reader_origin,
        BLAST_INFRA_READ_MODE: "committed-markets",
        BLAST_INFRA_API_KEY: infraKey,
        NEXT_PUBLIC_SITE_URL: "https://frontend.test",
        PRIVY_APP_ID: "populated-existing-app",
        PRIVY_JWT_VERIFICATION_KEY: pair.publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      };
      backendConfig(environment);

      async function start(file: string, extra: Record<string, string> = {}): Promise<string> {
        const port = await freePort();
        const child = fork(new URL(file, import.meta.url), [], {
          execPath: process.execPath,
          execArgv: [
            "--no-env-file",
            "--preload",
            new URL("./loopback-fetch-only.ts", import.meta.url).pathname,
          ],
          env: { ...environment, ...extra, PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        children.push(child);
        const retain = (chunk: Buffer) => {
          logs = (logs + chunk.toString()).slice(-100_000);
        };
        child.stdout?.on("data", retain);
        child.stderr?.on("data", retain);
        const origin = `http://127.0.0.1:${port}`;
        const deadline = performance.now() + 15_000;
        while (
          performance.now() < deadline &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          try {
            const response = await call(
              "readiness",
              origin,
              file.includes("relay-process") ? "/api/v1/unknown" : "/v1/live",
            );
            await response.body?.cancel();
            if (response.status === (file.includes("relay-process") ? 404 : 200)) {
              return origin;
            }
          } catch {
            /* Counted connection failures while the owned child starts. */
          }
          await pause(25);
        }
        let diagnostic = logs;
        const credentials = [
          partner.key,
          walletToken,
          infraKey,
          ...Object.entries(environment)
            .filter(([name]) =>
              /KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL|DATABASE_REPLICA_URL/.test(name),
            )
            .map(([, value]) => value),
        ];
        for (const value of credentials
          .filter((item): item is string => typeof item === "string")
          .sort((a, b) => b.length - a.length)) {
          if (value) {
            diagnostic = diagnostic.replaceAll(value, "[redacted]");
          }
        }
        report.startup_diagnostic = diagnostic
          .replace(/\b(?:postgres(?:ql)?|rediss?):\/\/\S+/gi, "[redacted-url]")
          .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
          .slice(-4_000);
        save();
        throw new Error(
          "Owned populated backend failed readiness (retained logs checked for secrets; no environment dump).",
        );
      }

      report.phase = "owned-process-readiness";
      save();
      const backend = await start("../src/main.ts");
      const relay = await start("./relay-process.ts", { TEST_BACKEND_ORIGIN: backend });
      report.phase = "quota-window-fence";
      save();
      // Quota expiry follows Redis TIME, not admission logs or the caller's clock.
      // Wait outside the measured matrix, then keep every finite counter proof in one minute.
      await fenceQuotaWindow();
      const matrixStarted = performance.now();
      report.phase = "native-case-matrix";
      const nativeHeaders = { "x-blast-infra-key": infraKey };
      const nativeBodies: Body[] = [];
      for (const item of fixture.cases) {
        const body = await json(
          `native-${item.id}`,
          fixture.reader_origin,
          item.path,
          nativeHeaders,
        );
        assert.deepEqual(
          committedBody(body),
          committedBody(item.body),
          "Live native response must match the nonce-bound ready body.",
        );
        nativeBodies.push(body);
      }
      const detail = nativeBodies[0]!;
      const totals = object(detail.totals);
      assert.equal(detail.presale_id, fixture.ids.presale_id);
      assert.equal(totals.total_commitments, "3000000000");
      assert.equal(String(object(detail.freshness).checkpoint), fixture.final_checkpoint);
      assert.equal(String(object(detail.freshness).timestamp_ms), fixture.fixture_timestamp_ms);
      const commitments = array(nativeBodies[1]!.commitments);
      assert.ok(commitments.length > 0);
      assert.equal(nativeBodies[2]!.presale_id, fixture.ids.presale_id);
      assert.equal(nativeBodies[2]!.address, fixture.ids.wallet);
      assert.ok(
        array(nativeBodies[2]!.commits).some(
          (item) => object(item).wallet_commitment === "1000000000",
        ),
      );
      assert.equal(nativeBodies[3]!.vault_id, fixture.ids.vault_id);
      assert.equal(object(nativeBodies[3]!.origin).id, fixture.ids.presale_id);
      assert.equal(nativeBodies[3]!.pool_id, fixture.ids.pool_id);
      const vaultProvenance = object(nativeBodies[3]!.provenance);
      assert.equal(vaultProvenance.network, fixture.network);
      assert.equal(vaultProvenance.deployment_fingerprint, fixture.deployment_fingerprint);
      const partnerHeaders = { "x-blast-partner-key": partner.key };
      const publicPath = `/api/v1/presales/${fixture.ids.presale_id}`;
      const namespace = quotaNamespace(
        recognition.BLAST_REDIS_NAMESPACE,
        deploymentIdentity(environment),
      );

      async function counters(label: string): Promise<Record<string, string>> {
        return observeCounters(label, `${namespace}:*:partner_read:*`);
      }

      const keySubject = createHmac("sha256", recognition.RATE_LIMIT_SUBJECT_PEPPER)
        .update(`api_key:${partner.id}`)
        .digest("hex");
      const expectedCounters = [60, 86_400]
        .map((seconds) => `${namespace}:{partner-quota}:partner_read:v1:${keySubject}:${seconds}`)
        .sort();
      assert.deepEqual(await counters("initial"), {});
      report.phase = "authenticated-presale-matrix";
      save();
      const direct = await json("partner-direct", backend, publicPath, partnerHeaders);
      const one = await counters("direct");
      assert.deepEqual(
        Object.keys(one),
        expectedCounters,
        "The issued API key owns exactly the minute and day counters.",
      );
      assert.ok(Object.values(one).every((value) => value.endsWith(":1")));
      const signed = await json("partner-signed-relay", relay, publicPath, partnerHeaders);
      const two = await counters("relay");
      assert.deepEqual(Object.keys(two), Object.keys(one), "Relay cannot change quota ownership.");
      assert.ok(Object.values(two).every((value) => value.endsWith(":2")));
      const signingKey = await importPKCS8(
        pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        "ES256",
      );
      const token = await new SignJWT({ sid: "existing-populated-session" })
        .setProtectedHeader({ alg: "ES256" })
        .setIssuer("privy.io")
        .setAudience(environment.PRIVY_APP_ID)
        .setSubject(did)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(signingKey);
      const own = await json(
        "first-party-signed-public",
        relay,
        `/api/social/presales/${fixture.ids.presale_id}`,
        {
          authorization: `Bearer ${token}`,
          cookie: `__Host-blast_wallet=${walletToken}`,
          origin: "https://frontend.test",
          "sec-fetch-site": "same-origin",
        },
      );
      const withoutObservation = (body: Body) => ({
        ...body,
        as_of: { ...object(body.as_of), lag_ms: 0 },
      });
      assert.deepEqual(withoutObservation(direct), withoutObservation(signed));
      assert.deepEqual(
        withoutObservation(direct),
        withoutObservation(object(v1PresaleDetail(own))),
        "Only the published v1 projection may differ.",
      );
      for (const body of [direct, signed, own]) {
        const sale = object(body.presale);
        assert.equal(sale.presale_id, fixture.ids.presale_id);
        assert.equal(sale.sale_token, fixture.ids.coin_type);
        assert.equal(sale.raised_atoms, totals.total_commitments);
        assert.equal(sale.target_atoms, object(detail.raise).target);
        const top = array(object(body.backers).top);
        assert.ok(
          top.some(
            (item) =>
              object(item).wallet === fixture.ids.wallet &&
              object(item).commitment_atoms === "1000000000",
          ),
        );
        const supply = object(object(body.terms).supply);
        assert.equal(supply.total, object(detail.supply).total);
        assert.deepEqual(supply.participants, {
          ...object(object(detail.supply).participants),
          bps: Number(object(object(detail.supply).participants).bps),
        });
        for (const share of ["liquidity", "protocol"]) {
          const expected = object(object(detail.supply)[share]);
          assert.deepEqual(supply[share], { ...expected, bps: Number(expected.bps) });
        }
        for (const side of ["supply", "raise"]) {
          const nativeSide = object(detail[side]);
          const actualSide = object(object(body.terms)[side]);
          assert.deepEqual(
            array(actualSide.recipients).map((entry) => {
              const { address, amount, bps } = object(entry);
              return { address, amount, bps };
            }),
            array(nativeSide.recipients).map((entry) => {
              const { address, amount, bps } = object(entry);
              return { address, amount, bps: Number(bps) };
            }),
          );
          const expected = object(nativeSide.protocol);
          assert.deepEqual(actualSide.protocol, { ...expected, bps: Number(expected.bps) });
        }
      }
      assert.deepEqual(
        await counters("first-party"),
        two,
        "First-party public reads never consume partner quota.",
      );
      const forgedPath = "/internal/public-read" + publicPath;
      const forgedRequest = new Request(backend + forgedPath, { headers: partnerHeaders });
      const forged = await call(
        "forged-first-party-no-fallback",
        backend,
        forgedPath,
        signGatewayRequest(
          forgedRequest,
          "wrong-synthetic-gateway-secret-0123456789",
          "127.0.0.1",
          namespace,
        ),
      );
      assert.equal(forged.status, 403);
      await forged.body?.cancel();
      assert.deepEqual(
        await counters("forged"),
        two,
        "Forged proof cannot fall back to partner authentication.",
      );
      const exhausted = await call(
        "partner-day-quota-exhausted",
        backend,
        publicPath,
        partnerHeaders,
      );
      assert.equal(exhausted.status, 429);
      await exhausted.body?.cancel();
      const afterExhaustion = await counters("exhausted");
      assert.deepEqual(Object.keys(afterExhaustion), Object.keys(two));
      assert.ok(await revokePartnerApiKey(product, partner.id, "operator:test"));
      for (const [label, origin] of [
        ["revoked-direct", backend],
        ["revoked-relay", relay],
      ] as const) {
        const denied = await call(label, origin, publicPath, partnerHeaders);
        assert.equal(denied.status, 401);
        await denied.body?.cancel();
      }
      assert.deepEqual(
        await counters("revoked"),
        afterExhaustion,
        "Revoked credentials cannot acquire quota or read data.",
      );
      assert.deepEqual(await retainedIdentity(product), identity);
      assert.equal(
        (await native.query("SELECT count(*)::int AS count FROM social_accounts")).rows[0].count,
        0,
        "Public replica metadata remains empty.",
      );
      let capacityKey = "";
      const profileProduct = product;

      async function runCatalogAndProfile() {
        report.phase = "finite-catalog-matrix";
        save();
        await createPartner(
          profileProduct,
          { id: "populated-capacity", origins: [] },
          "operator:test",
        );
        const capacityPartner = await issuePartnerApiKey(
          profileProduct,
          "populated-capacity",
          "synthetic-capacity",
          "operator:test",
        );
        capacityKey = capacityPartner.key;
        await setPartnerKeyPolicy(
          profileProduct,
          capacityPartner.id,
          { tier: "custom", requestsPerMinute: 100_000, requestsPerDay: 100_000 },
          "operator:test",
        );
        const capacityEnvironment = {
          BLAST_REDIS_NAMESPACE: recognition.BLAST_REDIS_NAMESPACE + ":capacity",
        };
        const capacityBackend = await start("../src/main.ts", capacityEnvironment);
        const backendChild = children.at(-1)!;
        const capacityRelay = await start("./relay-process.ts", {
          ...capacityEnvironment,
          TEST_BACKEND_ORIGIN: capacityBackend,
        });
        const relayChild = children.at(-1)!;
        const resource = (child: ChildProcess) => {
          const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const cpuTicks = Number(fields[11]) + Number(fields[12]);
          const rss = Number(
            /^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${child.pid}/status`, "utf8"))?.[1],
          );
          assert.ok(Number.isSafeInteger(cpuTicks) && Number.isFinite(rss) && rss > 0);
          return { cpuTicks, rss };
        };
        const profileHeaders = { "x-blast-partner-key": capacityKey };
        const ownHeaders = {
          authorization: `Bearer ${token}`,
          cookie: `__Host-blast_wallet=${walletToken}`,
          origin: "https://frontend.test",
          "sec-fetch-site": "same-origin",
        };
        // The native fixture has one ended sale. These are supported consumer variants,
        // not a claim of deep pagination or a larger native presale population.
        const variants = [
          { id: "detail", path: publicPath, project: v1PresaleDetail },
          {
            id: "ended-one",
            path: "/api/v1/presales?status=ended&sort=recent&limit=1",
            project: v1PresaleSummaries,
          },
          {
            id: "ended-fifty",
            path: "/api/v1/presales?status=ended&sort=recent&limit=50",
            project: v1PresaleSummaries,
          },
          {
            id: "upcoming-empty",
            path: "/api/v1/presales?status=upcoming&sort=opening&limit=1",
            project: v1PresaleSummaries,
          },
          { id: "featured-empty", path: "/api/v1/presales/featured", project: v1PresaleSummaries },
        ];
        const stable = (body: Body) => (body.as_of ? withoutObservation(body) : body);
        const baselines = new Map<string, { partner: Body; firstParty: Body }>();
        const capacityNamespace = quotaNamespace(
          capacityEnvironment.BLAST_REDIS_NAMESPACE,
          deploymentIdentity({ ...environment, ...capacityEnvironment }),
        );
        const capacitySubject = createHmac("sha256", recognition.RATE_LIMIT_SUBJECT_PEPPER)
          .update(`api_key:${capacityPartner.id}`)
          .digest("hex");
        const capacityDaily = `${capacityNamespace}:{partner-quota}:partner_read:v1:${capacitySubject}:86400`;
        const allowedCapacityKeys = new Set([capacityDaily, capacityDaily.replace(/86400$/, "60")]);
        let matrixPartnerReads = 0;

        async function assertCapacityQuota(expected: number): Promise<number> {
          const observed = await observeCounters(
            `catalog-${report.catalog_matrix.calls.length}-expected-${expected}`,
            `${capacityNamespace}:*:partner_read:*`,
          );
          const keys = Object.keys(observed);
          assert.ok(
            keys.every((key) => allowedCapacityKeys.has(key)),
            "Every catalog call must preserve the issued key's quota ownership.",
          );
          const raw = observed[capacityDaily] ?? null;
          if (expected === 0) {
            assert.deepEqual(keys, [], "Catalog quota must begin without any partner counter.");
            assert.equal(raw, null, "Catalog quota must begin unused.");
            return 0;
          }
          assert.ok(keys.includes(capacityDaily), "The issued key owns its daily counter.");
          const counter = /^([0-9]+):([0-9]+)$/.exec(String(raw));
          assert.ok(counter, "The daily counter must contain its window and exact usage.");
          const count = Number(counter[2]);
          assert.equal(
            count,
            expected,
            "Each serial catalog call must charge its exact quota delta.",
          );
          return count;
        }

        async function catalogRead(
          id: string,
          transport: string,
          origin: string,
          path: string,
          headers: HeadersInit,
          charge: number,
        ): Promise<Body> {
          const before = await assertCapacityQuota(matrixPartnerReads);
          const proof = {
            id,
            transport,
            elapsed_ms: 0,
            expected_delta: charge,
            before_count: before,
            after_count: null as number | null,
            daily_owner: capacityDaily,
          };
          report.catalog_matrix.calls.push(proof);
          const started = performance.now();
          try {
            const body = await json(`catalog-${transport}-${id}`, origin, path, headers);
            matrixPartnerReads += charge;
            proof.after_count = await assertCapacityQuota(matrixPartnerReads);
            return body;
          } finally {
            proof.elapsed_ms = performance.now() - started;
            save();
          }
        }

        const catalogStarted = performance.now();
        for (const variant of variants) {
          const publicBody = await catalogRead(
            variant.id,
            "direct",
            capacityBackend,
            variant.path,
            profileHeaders,
            1,
          );
          const relayedBody = await catalogRead(
            variant.id,
            "relay",
            capacityRelay,
            variant.path,
            profileHeaders,
            1,
          );
          const firstPartyBody = await catalogRead(
            variant.id,
            "first-party",
            capacityRelay,
            variant.path.replace("/api/v1/", "/api/social/"),
            ownHeaders,
            0,
          );
          assert.deepEqual(stable(publicBody), stable(relayedBody));
          assert.deepEqual(stable(publicBody), stable(object(variant.project(firstPartyBody))));
          if (variant.id.startsWith("ended-")) {
            const rows = array(publicBody.presales);
            assert.equal(rows.length, 1, "The archival fixture has one ended presale.");
            const sale = object(rows[0]);
            assert.equal(sale.presale_id, fixture.ids.presale_id);
            assert.equal(sale.raised_atoms, "3000000000");
            assert.equal(publicBody.next_cursor, null);
          } else if (variant.id.endsWith("empty")) {
            assert.deepEqual(publicBody.presales, []);
            if (variant.id === "upcoming-empty") {
              assert.equal(publicBody.next_cursor, null);
            }
          }
          baselines.set(variant.id, {
            partner: stable(publicBody),
            firstParty: stable(firstPartyBody),
          });
        }
        report.catalog_matrix.elapsed_ms = Math.ceil(performance.now() - catalogStarted);
        assert.equal(report.catalog_matrix.calls.length, 15);
        assert.equal(matrixPartnerReads, 10);
        await assertCapacityQuota(10);
        assert.deepEqual(await retainedIdentity(profileProduct), identity);
        const finiteDaily = expectedCounters.find((key) => key.endsWith(":86400"))!;
        assert.equal(await redis.execute(["GET", finiteDaily]), afterExhaustion[finiteDaily]);
        report.matrix_elapsed_ms = Math.ceil(performance.now() - matrixStarted);
        assert.ok(
          report.matrix_elapsed_ms <= 60_000,
          "Finite native and authenticated catalog matrix must finish within 60 seconds.",
        );
        save();
        if (!profileMs) {
          return;
        }
        report.phase = "sustained-populated-profile";
        save();
        const positions = [0, 0, 0];
        const routes: Record<string, Record<string, RouteTotals>> = {};
        const before = { backend: resource(backendChild), relay: resource(relayChild) };
        const peaks = { backend: before.backend.rss, relay: before.relay.rss };
        let samples = 1;
        let samplingFailed = false;
        const sample = () => {
          try {
            peaks.backend = Math.max(peaks.backend, resource(backendChild).rss);
            peaks.relay = Math.max(peaks.relay, resource(relayChild).rss);
            samples++;
          } catch {
            samplingFailed = true;
          }
        };
        const sampler = setInterval(sample, 1_000);
        let profile: Awaited<ReturnType<typeof mixedReadProfile>>;
        try {
          profile = await mixedReadProfile({
            durationMs: profileMs,
            labels: ["partner_direct", "partner_relay", "first_party"],
            thinkTimeMs: 1_250,
            async request(worker) {
              const firstParty = worker === 2;
              const position = positions[worker]!;
              positions[worker] = position + 1;
              const variant = variants[position % variants.length]!;
              const workerRoutes = (routes[String(worker)] ??= {});
              const route = (workerRoutes[variant.id] ??= {
                attempts: 0,
                valid: 0,
                statuses: {},
                errors: {},
              });
              route.attempts++;
              let response: Response;
              try {
                response = await fetch(
                  (worker === 0 ? capacityBackend : capacityRelay) +
                    (firstParty ? variant.path.replace("/api/v1/", "/api/social/") : variant.path),
                  {
                    headers: firstParty ? ownHeaders : profileHeaders,
                    redirect: "error",
                    signal: AbortSignal.timeout(5_000),
                  },
                );
              } catch {
                route.errors.transport = (route.errors.transport ?? 0) + 1;
                return { status: null, error: "transport" };
              }
              const status = String(response.status);
              route.statuses[status] = (route.statuses[status] ?? 0) + 1;
              if (response.status !== 200) {
                route.errors.http_status = (route.errors.http_status ?? 0) + 1;
                await response.body?.cancel();
                return { status: response.status };
              }
              try {
                assert.equal(response.headers.get("set-cookie"), null);
                const body = object(await response.json());
                const expected = baselines.get(variant.id)!;
                assert.deepEqual(stable(body), firstParty ? expected.firstParty : expected.partner);
                route.valid++;
                return { status: 200 };
              } catch {
                route.errors.validation = (route.errors.validation ?? 0) + 1;
                return { status: 200, error: "validation" };
              }
            },
          });
        } finally {
          clearInterval(sampler);
        }
        const completed = Object.fromEntries(
          Object.entries(profile.groups).map(([label, group]) => [
            label,
            Object.values(group.statuses).reduce((sum, count) => sum + count, 0),
          ]),
        );
        report.sustained_profile = {
          profile,
          completed,
          resources: {},
          routes,
          matrixPartnerReads,
          samples,
          samplingFailed,
          scope:
            "Synthetic one-sale fixture; five supported detail/catalog variants rotated by each of three paced closed-loop clients with 1250ms think time per client; no deep catalog pagination, offered-load or hosted capacity claim.",
        };
        report.requests += Object.values(profile.groups).reduce(
          (sum, group) => sum + group.attempts,
          0,
        );
        report.errors += Object.values(profile.groups).reduce(
          (sum, group) => sum + group.attempts - group.valid,
          0,
        );
        save();
        sample();
        try {
          const after = { backend: resource(backendChild), relay: resource(relayChild) };
          report.sustained_profile.resources = {
            backend: {
              cpuTicks: after.backend.cpuTicks - before.backend.cpuTicks,
              peakRssKiB: peaks.backend,
            },
            relay: {
              cpuTicks: after.relay.cpuTicks - before.relay.cpuTicks,
              peakRssKiB: peaks.relay,
            },
          };
        } catch {
          samplingFailed = true;
        }
        report.sustained_profile.samples = samples;
        report.sustained_profile.samplingFailed = samplingFailed;
        save();
        assert.equal(samplingFailed, false, "Live child resource samples are required.");
        for (const group of Object.values(profile.groups)) {
          assert.ok(group.attempts > 0);
          assert.equal(group.valid, group.attempts);
          assert.deepEqual(group.errors, {});
        }
        for (const worker of ["0", "1", "2"]) {
          assert.deepEqual(
            Object.keys(routes[worker] ?? {}).sort(),
            variants.map(({ id }) => id).sort(),
          );
          for (const totals of Object.values(routes[worker]!)) {
            assert.ok(totals.attempts > 0);
            assert.equal(
              totals.valid,
              totals.attempts,
              "Every supported variant must remain exact.",
            );
            assert.deepEqual(totals.statuses, { 200: totals.attempts });
            assert.deepEqual(totals.errors, {});
          }
        }
        const partnerAttempts =
          profile.groups.partner_direct!.attempts + profile.groups.partner_relay!.attempts;
        const capacityDailyKeys = (await redis.execute([
          "KEYS",
          `${capacityNamespace}:*:partner_read:*:86400`,
        ])) as string[];
        assert.deepEqual(
          capacityDailyKeys.sort(),
          [capacityDaily],
          "Only the capacity partner key may own daily quota.",
        );
        assert.ok(
          String(await redis.execute(["GET", capacityDaily])).endsWith(
            `:${matrixPartnerReads + partnerAttempts}`,
          ),
          "Each partner read charges its separate capacity key once; first-party reads charge none.",
        );
        assert.deepEqual(await retainedIdentity(profileProduct), identity);
        const daily = expectedCounters.find((key) => key.endsWith(":86400"))!;
        assert.equal(await redis.execute(["GET", daily]), afterExhaustion[daily]);
      }

      await runCatalogAndProfile();
      for (const secret of [
        partner.key,
        ...(capacityKey ? [capacityKey] : []),
        infraKey,
        token,
        walletToken,
        new URL(environment.DATABASE_URL).password,
        new URL(environment.DATABASE_REPLICA_URL).password,
        new URL(environment.PARTNER_VERIFIER_DATABASE_URL).password,
      ]) {
        assert.ok(!logs.includes(secret), "Owned process logs must not expose credentials.");
      }
      report.passed = true;
      report.phase = "passed";
    } finally {
      try {
        for (const child of children.reverse()) {
          await stop(child);
        }
        configuredRedis("quota")?.close();
        redis.close();
        await product?.end();
        await native.end();
        for (const cleanup of cleanups.reverse()) {
          await cleanup();
        }
        await dropProduct?.();
        restoreEnvironment(prior);
        report.complete = true;
      } catch {
        report.passed = false;
        throw new Error("Owned populated proof cleanup failed.");
      } finally {
        report.elapsed_ms = Math.ceil(performance.now() - started);
        save();
      }
    }
  },
);
