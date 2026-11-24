import { deploymentIdentity } from "@blast/core/lib/config/deployment-identity.ts";
import { partnerVerifierFixture } from "./partner-verifier-fixture.ts";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { SignJWT, importPKCS8 } from "jose";
import { Pool } from "pg";
import { createRedisConnection } from "@blast/core/lib/redis.ts";
import {
  RedisRateLimitEnforcer,
  quotaNamespace,
} from "@blast/core/lib/web-security/redis-rate-limits.ts";
import { replicaPooledUrl } from "@blast/core/modules/database/topology.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { walletSessionTokenHash } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { privateBackendRelay } from "@blast/server/private/relay.ts";
import { parseRelayConfig } from "@blast/server/private/relay-config.ts";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";
import { decodeCreateContext } from "@blast/core/modules/social/create/context.ts";
import { BLAST_DEPLOYMENTS, presaleDeployment } from "@interest-protocol/blast-sdk/deployments";
import { buildPresaleCoinPackageBytecode } from "@interest-protocol/blast-sdk/presale";
import { normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { capacityFixture } from "./capacity-fixture.ts";

import sharp from "sharp";
import {
  DEFAULT_RATE_POLICIES,
  rateLimitSubjectKey,
} from "@blast/core/lib/web-security/rate-limits.ts";
import { seedPresaleStory } from "../../../packages/core/test/fixtures/modules/social/presales/presale-story.ts";
import { decodeReferralContext } from "@blast/core/modules/social/referrals/share-context.ts";
import { createPresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { EMPTY_SALE_METADATA } from "@blast/core/modules/social/contracts/sales.ts";
import { renderPresaleSharePng } from "@blast/server/modules/presale/share/image.ts";
import { renderReferralSharePng } from "@blast/server/modules/social/referrals/share-image.ts";
import type { ShareRenderJob } from "@blast/server/modules/share-images/renderer.ts";
import { freePort, waitForHealth } from "./kit.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../packages/server/test/fixtures/config/runtime-config.ts";

async function shareJobs(): Promise<ShareRenderJob[]> {
  // Deterministic high entropy, largest normalized dimensions; not a compressed-size worst case.
  const raw = Buffer.alloc(512 * 512 * 4);
  let state = 0x12345678;
  for (let offset = 0; offset < raw.length; offset++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    raw[offset] = offset % 4 === 3 ? 255 : state & 255;
  }
  const logo = createPresaleReceiptLogo(
    await sharp(raw, { raw: { width: 512, height: 512, channels: 4 } })
      .png()
      .toBuffer(),
  );
  return [
    {
      kind: "presale",
      sale: {
        presale_id: "0x" + "1".repeat(64),
        name: "W".repeat(32),
        symbol: "W".repeat(10),
        icon_url: "",
        phase: "open",
        venue: "cetus",
        start_ms: 1,
        end_ms: 2,
        ended_ms: null,
        launched_ms: null,
        target_usd: null,
        raised_usd: null,
        quote_symbol: "SUI",
        quote_type: "0x2::sui::SUI",
        quote_decimals: 9,
        target_atoms: "9".repeat(78),
        raised_atoms: "8".repeat(78),
        fill_bps: 8888,
        participants: 999999,
        interested: 999999,
        presale_price_usd: null,
        presale_price_quote: null,
        price_usd: null,
        multiple: null,
        verified_team: true,
        audited: true,
        metadata: { ...EMPTY_SALE_METADATA, tagline: "W".repeat(80) },
      },
      artwork: { logo, cover: logo },
    },
    {
      kind: "referral",
      inviter: { callsign: "w".repeat(20), crew: 999999, title: "W".repeat(80), avatarUrl: null },
      avatar: logo,
    },
    {
      kind: "referral",
      inviter: { callsign: "w".repeat(20), crew: null, title: null, avatarUrl: null },
      avatar: logo,
    },
  ];
}

async function exerciseShareCpu(
  child: ChildProcess,
  relay: ReturnType<typeof privateBackendRelay>,
  identity: Record<string, string>,
  accountId: string,
  jobs: ShareRenderJob[],
  expectedHashes: string[],
  t: TestContext,
) {
  async function readAccount() {
    const begin = performance.now();
    const response = await relay(
      new Request("https://frontend.test/api/social/me", {
        headers: { origin: "https://frontend.test", "sec-fetch-site": "same-origin", ...identity },
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.account_id ?? body.account?.account_id, accountId);
    return performance.now() - begin;
  }

  const baseline: number[] = [];
  for (let index = 0; index < 10; index++) {
    baseline.push(await readAccount());
    await pause(50);
  }
  type Result = {
    kind: string;
    count: number;
    times: number[];
    hashes: { job: number; hash: string }[];
    durationMs: number;
    failed: boolean;
  };
  let active = false;
  let result: Result | undefined;
  const listener = (message: unknown) => {
    if (!message || typeof message !== "object") {
      return;
    }
    const value = message as Result;
    if (value.kind === "share-start") {
      active = true;
    }
    if (value.kind === "share-done") {
      result = value;
    }
  };
  child.on("message", listener);
  try {
    child.send({ kind: "fixture-share-run", jobs });
    const deadline = Date.now() + 120_000;
    while (!active && !result && Date.now() < deadline) {
      await pause(5);
    }
    assert.equal(active, true);
    const loaded: number[] = [];
    let overlapped = 0;
    while (!result && Date.now() < deadline) {
      loaded.push(await readAccount());
      if (!result) {
        overlapped++;
      }
      await pause(100);
    }
    assert.ok(result, "Shared renderer must settle every job");
    assert.equal(result.failed, false);
    assert.equal(result.count, 6);
    assert.equal(result.times.length, 6);
    for (const item of result.hashes) {
      assert.equal(item.hash, expectedHashes[item.job], "Exact direct-render PNG equivalence");
    }
    assert.ok(
      overlapped > 0,
      "Real account response completed while this Bun process owned render work",
    );
    t.diagnostic(
      JSON.stringify({
        scope: "same Bun isolated image/account overlap; no SLO or RSS guarantee",
        baseline: distribution(baseline),
        loaded: distribution(loaded),
        overlapped,
        renderer: distribution(result.times),
        durationMs: result.durationMs,
        count: result.count,
        hashes: expectedHashes,
        serializedJobBytes: jobs.map((job) => Buffer.byteLength(JSON.stringify(job))),
      }),
    );
  } finally {
    child.off("message", listener);
  }
}

async function exerciseShareRoutes(input: {
  index: number;
  backend: string;
  presaleId: string;
  namespace: string;
  environment: Readonly<Record<string, string | undefined>>;
  pool: Pool;
  redis: ReturnType<typeof createRedisConnection>;
  diagnostics: () => unknown;
}) {
  const { index, backend, presaleId, namespace, environment, pool, redis } = input;
  const subjectPepper = environment.RATE_LIMIT_SUBJECT_PEPPER;
  assert.ok(subjectPepper);
  const shareIp = `192.0.2.${20 + index}`;
  const shareRelay = privateBackendRelay(
    parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: backend }),
    { clientAddress: () => shareIp },
  );
  const imagePath = `/presale/${presaleId}/share-image`;
  const policy = DEFAULT_RATE_POLICIES.social_read_presales;
  const hashFor = (ip: string) =>
    createHmac("sha256", subjectPepper).update(rateLimitSubjectKey(policy, { ip })).digest("hex");
  const counterKey = (ip: string) =>
    `${namespace}:{partner-quota}:social_read_presales:v${policy.version}:${hashFor(ip)}:60`;

  async function quotaWindow() {
    const time = (await redis.execute(["TIME"])) as string[];
    const seconds = Number(time[0]);
    assert.ok(Number.isSafeInteger(seconds));
    if (seconds % 60 > 44) {
      await pause((60 - (seconds % 60)) * 1000 + 25);
    }
    const current = (await redis.execute(["TIME"])) as string[];
    return Number(current[0]) - (Number(current[0]) % 60);
  }

  async function counter(ip: string) {
    const raw = await redis.execute(["GET", counterKey(ip)]);
    if (raw === null) {
      return null;
    }
    assert.equal(typeof raw, "string");
    assert.match(raw as string, /^\d+:\d+$/);
    const [start, count] = (raw as string).split(":").map(Number);
    assert.ok(Number.isSafeInteger(start) && Number.isSafeInteger(count));
    return { start, count };
  }

  const imageWindow = await quotaWindow();
  const count = async () => {
    const stored = await counter(shareIp);
    if (!stored) {
      return 0;
    }
    assert.equal(
      stored.start,
      imageWindow,
      "Quota sequence must remain inside the observed Redis window",
    );
    return stored.count;
  };

  async function image(method = "GET") {
    const before = await count();
    const response = await shareRelay(new Request("https://frontend.test" + imagePath, { method }));
    assert.equal(
      response.status,
      200,
      JSON.stringify({ response: await response.clone().text(), diagnostics: input.diagnostics() }),
    );
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(
      await count(),
      before + 1,
      "One real default public-read admission, including cached image and HEAD",
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (method === "HEAD") {
      assert.equal(bytes.length, 0);
    } else {
      const metadata = await sharp(bytes).metadata();
      assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", 1200, 675]);
    }
    return createHash("sha256").update(bytes).digest("hex");
  }

  const firstHash = await image();
  assert.equal(await image(), firstHash);
  await image("HEAD");
  await pool.query("UPDATE blast_infra_fixture.presales SET sale_name=$1 WHERE presale_id=$2", [
    `Changed fixture ${index}`,
    presaleId,
  ]);
  assert.notEqual(
    await image(),
    firstHash,
    "Canonical detail cache0 observes changed data before image revision lookup",
  );
  assert.equal((await fetch(backend + imagePath)).status, 403);
  const beforeDenied = await count();
  assert.equal(
    (
      await shareRelay(
        new Request("https://frontend.test" + imagePath, {
          headers: { "content-length": "1" },
        }),
      )
    ).status,
    413,
  );
  assert.equal(await count(), beforeDenied, "Rejected bodies do not consume public-read quota");
  const exhaustedIp = `192.0.2.${30 + index}`;
  const limiter = new RedisRateLimitEnforcer({ redis, namespace, subjectPepper: subjectPepper });
  const exhaustedWindow = await quotaWindow();
  for (let request = 0; request < 300; request++) {
    assert.equal(
      (await limiter.consume("social_read_presales", { ip: exhaustedIp })).allowed,
      true,
    );
  }
  const exhaustedBefore = await counter(exhaustedIp);
  assert.deepEqual(exhaustedBefore, { start: exhaustedWindow, count: 300 });
  const exhaustedRelay = privateBackendRelay(
    parseRelayConfig({ ...environment, BLAST_BACKEND_API_ORIGIN: backend }),
    { clientAddress: () => exhaustedIp },
  );
  const refused = await exhaustedRelay(new Request("https://frontend.test" + imagePath));
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("retry-after"), "5");
  assert.deepEqual(
    await counter(exhaustedIp),
    exhaustedBefore,
    "Refusal must not change either counter epoch or value",
  );
  const contextPath = "/api/social/referral-inviter/retained_pilot";
  assert.equal((await shareRelay(new Request("https://frontend.test" + contextPath))).status, 404);
  const referralContext = await shareRelay(
    new Request("https://frontend.test" + contextPath),
    "ssr-read",
  );
  assert.equal(referralContext.status, 200);
  assert.deepEqual(decodeReferralContext(await referralContext.text(), "retained_pilot"), {
    callsign: "retained_pilot",
    crew: null,
    title: null,
    avatarUrl: null,
  });
  for (const method of ["GET", "HEAD"]) {
    const referral = await shareRelay(
      new Request("https://frontend.test/referral/retained_pilot/image", { method }),
    );
    assert.equal(referral.status, 200);
    assert.equal(
      referral.headers.get("cache-control"),
      "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
    );
    const bytes = Buffer.from(await referral.arrayBuffer());
    if (method === "HEAD") {
      assert.equal(bytes.length, 0);
    } else {
      assert.deepEqual(
        [(await sharp(bytes).metadata()).width, (await sharp(bytes).metadata()).height],
        [1200, 675],
      );
    }
  }
}

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

type CpuResult = {
  kind: string;
  count: number;
  hashes: string[];
  times: number[];
  durationMs: number;
  failed: boolean;
};

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    max: sorted.at(-1),
  };
}

async function exerciseCpu(
  child: ChildProcess,
  relay: ReturnType<typeof privateBackendRelay>,
  identity: Record<string, string>,
  accountId: string,
  t: TestContext,
) {
  const coin = {
    name: "Meridian",
    symbol: "MRDN",
    description: "Representative local SDK fixture",
    iconUrl: "https://fixture.invalid/processed.webp",
    decimals: 9,
  };
  const deployment = presaleDeployment(BLAST_DEPLOYMENTS.mainnet!);
  const module = await buildPresaleCoinPackageBytecode(
    { ...coin, metadataCapRecipient: null },
    deployment,
  );
  const dependencies = [
    normalizeSuiAddress("0x1"),
    normalizeSuiAddress("0x2"),
    deployment.admin.packageId,
    deployment.partners.packageId,
    deployment.vestingPackageId,
    deployment.core.packageId,
    deployment.packageId,
  ];
  const expectedHash = createHash("sha256")
    .update(JSON.stringify({ modules: [toBase64(module)], dependencies }))
    .digest("hex");

  async function readAccount() {
    const begin = performance.now();
    const response = await relay(
      new Request("https://frontend.test/api/social/me", {
        headers: { origin: "https://frontend.test", "sec-fetch-site": "same-origin", ...identity },
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json();
    assert.equal(body.account_id ?? body.account?.account_id, accountId);
    return performance.now() - begin;
  }

  const baseline: number[] = [];
  for (let index = 0; index < 10; index++) {
    baseline.push(await readAccount());
    await pause(50);
  }
  let active = false;
  let completed = false;
  let result: CpuResult | undefined;
  const listener = (message: unknown) => {
    if (!message || typeof message !== "object") {
      return;
    }
    const value = message as CpuResult;
    if (value.kind === "bytecode-start") {
      active = true;
    }
    if (value.kind === "bytecode-done") {
      result = value;
      completed = true;
    }
  };
  child.on("message", listener);
  try {
    child.send("fixture-bytecode-run");
    const deadline = Date.now() + 20_000;
    while (!active && !completed && Date.now() < deadline) {
      await pause(5);
    }
    assert.equal(active, true, "CPU workload must begin in actual backend process");
    const loaded: number[] = [];
    let overlapped = 0;
    while (!completed && Date.now() < deadline) {
      loaded.push(await readAccount());
      if (!completed) {
        overlapped++;
      }
      await pause(50);
    }
    assert.ok(result, "CPU workload must settle");
    assert.equal(result.failed, false);
    assert.equal(result.count, 16);
    assert.equal(result.times.length, 16);
    assert.ok(result.hashes.every((hash) => hash === expectedHash));
    assert.ok(
      overlapped > 0,
      "Actual account responses must complete while CPU work remains active",
    );
    t.diagnostic(
      JSON.stringify({
        scope: "same Bun process local bytecode/account overlap, no SLO claim",
        baseline: distribution(baseline),
        loaded: distribution(loaded),
        overlapped,
        bytecode: distribution(result.times),
        durationMs: result.durationMs,
        count: result.count,
        hash: expectedHash,
      }),
    );
  } finally {
    child.off("message", listener);
  }
}

test(
  "create transports and offline bytecode preserve retained identities while serving account reads",
  { timeout: 300_000 },
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
    assert.throws(
      () => replicaPooledUrl({ DATABASE_URL: database, DATABASE_REPLICA_URL: database }),
      /must name the read replica/,
    );
    // Explicit reader-endpoint emulation into this fixture PG, not actual replication or lag evidence.
    const sockets = new Set<Socket>();
    const proxyStats = { accepted: 0, active: 0, peak: 0, dropped: 0 };
    const target = new URL(database);
    const readerProxy = createServer((socket) => {
      proxyStats.accepted++;
      proxyStats.active++;
      proxyStats.peak = Math.max(proxyStats.peak, proxyStats.active);
      socket.once("close", () => {
        proxyStats.active--;
      });
      const upstream = connect({ host: "127.0.0.1", port: Number(target.port) });
      for (const connection of [socket, upstream]) {
        sockets.add(connection);
        connection.once("close", () => sockets.delete(connection));
        connection.on("error", () => {
          socket.destroy();
          upstream.destroy();
        });
      }
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
      socket.pipe(upstream).pipe(socket);
    });
    readerProxy.maxConnections = 20;
    readerProxy.on("drop", () => {
      proxyStats.dropped++;
    });
    readerProxy.listen(0, "127.0.0.1");
    await once(readerProxy, "listening");
    const readerUrl = new URL(database);
    readerUrl.port = String((readerProxy.address() as { port: number }).port);
    t.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => readerProxy.close(() => resolve()));
    });
    const pool = new Pool({ connectionString: database, max: 2 });
    const redis = createRedisConnection(redisUrl, "quota");
    t.after(async () => {
      redis.close();
      await pool.end();
    });
    await migrateDatabase(pool);
    const story = await seedPresaleStory(pool, { nowMs: Date.now(), social: false, crowd: 0 });
    await pool.query("UPDATE blast_infra_fixture.presales SET sale_icon_url=''");
    const jobs = await shareJobs();
    const expectedHashes: string[] = [];
    for (const job of jobs) {
      const bytes = await (job.kind === "presale"
        ? renderPresaleSharePng(job.sale, job.artwork)
        : renderReferralSharePng(job.inviter, job.avatar));
      const metadata = await sharp(bytes).metadata();
      assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", 1200, 675]);
      expectedHashes.push(createHash("sha256").update(bytes).digest("hex"));
    }
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
    const foreignAccountId = randomUUID();
    await pool.query(
      "INSERT INTO social_accounts(account_id,privy_did,callsign) VALUES($1,'did:privy:foreign-create','foreign_create')",
      [foreignAccountId],
    );
    const beforeAllAccounts = (
      await pool.query("SELECT * FROM social_accounts ORDER BY account_id")
    ).rows;
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
      BLAST_PRESALE_ENABLED: "team",
      BLAST_SOCIAL_ENABLED: "team",
      DATABASE_URL: database,
      PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(database, t),
      DATABASE_REPLICA_URL: readerUrl.href,
      BLAST_QUOTA_REDIS_URL: redisUrl,
      BLAST_REDIS_NAMESPACE: `private-create:${randomUUID()}`,
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
    await Promise.all(paidKeys.map((key) => redis.execute(["PEXPIRE", key, "360000"])));
    const paidBefore = await Promise.all(paidKeys.map((key) => redis.execute(["GET", key])));
    assert.equal(paidKeys.length, 2);
    const cwd = await mkdtemp(join(tmpdir(), "blast-private-create-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const logs: string[] = [];
    const children: ChildProcess[] = [];

    async function start() {
      const port = await freePort();
      const child = spawn(
        process.execPath,
        [
          "--no-env-file",
          "--preload",
          new URL("./loopback-fetch-only.ts", import.meta.url).pathname,
          "--preload",
          new URL("./create-cpu.preload.ts", import.meta.url).pathname,
          "--preload",
          new URL("./share-render-cpu.preload.ts", import.meta.url).pathname,
          new URL("../src/main.ts", import.meta.url).pathname,
        ],
        {
          cwd,
          env: { ...environment, PORT: String(port) },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      children.push(child);
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

      const draftId = randomUUID();
      const path = `me/drafts/${draftId}`;
      const draft = blankDraft();
      const saved = await call(
        path,
        "PUT",
        JSON.stringify({ version: 0, draft }).padEnd(65536, " "),
      );
      assert.equal(
        saved.status,
        201,
        JSON.stringify({
          response: await saved.clone().text(),
          metrics: logs
            .join("")
            .split("\n")
            .flatMap((line) => {
              try {
                const value = JSON.parse(line);
                return [
                  {
                    metric: value.metric,
                    label: value.label,
                    error: value.error,
                    cause: value.cause,
                    code: value.code,
                    outcome: value.outcome,
                  },
                ];
              } catch {
                return [];
              }
            })
            .slice(-15),
        }),
      );
      const value = await saved.json();
      assert.equal(value.version, 1);
      assert.equal(value.draft_id, draftId);
      const read = await call(path);
      assert.equal(read.status, 200);
      assert.deepEqual((await read.json()).draft, draft);
      const list = await call("me/drafts");
      assert.equal(list.status, 200);
      assert.ok(
        (await list.json()).items.some((item: { draft_id: string }) => item.draft_id === draftId),
      );
      assert.equal((await call(path, "PUT", JSON.stringify({ version: 0, draft }))).status, 200);
      const conflict = await call(
        path,
        "PUT",
        JSON.stringify({ version: 0, draft: { ...draft, name: "Changed" } }),
      );
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error.code, "draft_conflict");
      const foreignId = randomUUID();
      // A real foreign row, not merely a missing ID; reuse the seeded fixture account below.
      await pool.query(
        "INSERT INTO social_presale_drafts(draft_id,account_id,version,body) VALUES($1,$2,1,$3::jsonb)",
        [foreignId, foreignAccountId, JSON.stringify(draft)],
      );
      assert.equal((await call(`me/drafts/${foreignId}`)).status, 404);
      assert.equal(
        (await call(`me/drafts/${foreignId}`, "PUT", JSON.stringify({ version: 1, draft }))).status,
        404,
      );
      for (const target of ["me/drafts", path]) {
        const head = await call(target, "HEAD");
        assert.equal(head.status, 200);
        assert.equal(await head.text(), "");
      }
      for (const [suffix, method, cap, expected] of [
        ["logo", "PUT", 2097152, 503],
        ["cover", "POST", 4016384, 503],
        ["published", "POST", 1024, 400],
        ["publish", "POST", 4096, 400],
      ] as const) {
        const response = await call(`${path}/${suffix}`, method, "{}".padEnd(cap, " "));
        assert.equal(response.status, expected, `${suffix}: ${await response.clone().text()}`);
        assert.equal((await call(`${path}/${suffix}`, method, " ".repeat(cap + 1))).status, 413);
      }
      assert.equal((await call(`${path}/cover`, "DELETE")).status, 200);
      assert.equal((await call(path, "PUT", " ".repeat(65537))).status, 413);
      assert.equal(
        (await call(path, "PUT", "{}", { origin: "https://wrong.invalid" })).status,
        403,
      );
      assert.equal(
        (await call("me/drafts", "GET", undefined, { "x-blast-partner-key": "synthetic-partner" }))
          .status,
        403,
      );
      const anonymous = await relay(new Request("https://frontend.test/api/social/me/drafts"));
      assert.equal(anonymous.status, 401);
      const browserContext = await call("create-context");
      assert.equal(browserContext.status, 404);
      const context = await relay(
        new Request("https://frontend.test/api/social/create-context"),
        "ssr-read",
      );
      assert.equal(context.status, 200, await context.clone().text());
      assert.equal(context.headers.get("cache-control"), "private, no-store");
      decodeCreateContext(await context.text());
      await exerciseCpu(children[index], relay, identityHeaders[index], accountId, t);
      assert.equal((await call(path, "DELETE")).status, 204);
      assert.equal((await call(path)).status, 404);
      await exerciseShareCpu(
        children[index],
        relay,
        identityHeaders[index],
        accountId,
        jobs,
        expectedHashes,
        t,
      );
      await exerciseShareRoutes({
        index,
        backend,
        presaleId: story.presaleIds.MRDN,
        namespace,
        environment,
        pool,
        redis,
        diagnostics: () => ({
          proxy: proxyStats,
          metrics: logs
            .join("")
            .split("\n")
            .flatMap((line) => {
              try {
                const value = JSON.parse(line);
                return [
                  {
                    metric: value.metric,
                    label: value.label,
                    error: value.error,
                    code: value.code,
                    outcome: value.outcome,
                  },
                ];
              } catch {
                return [];
              }
            })
            .slice(-30),
        }),
      });
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
    assert.deepEqual(
      (await pool.query("SELECT * FROM social_accounts ORDER BY account_id")).rows,
      beforeAllAccounts,
    );
    assert.equal(
      proxyStats.dropped,
      0,
      "Reader forwarder admits both configured ten-connection replica pools",
    );
    t.diagnostic(
      JSON.stringify({
        readerProxy: proxyStats,
        scope: "Two bounded pools into owned PG; not real replication performance",
      }),
    );
    assert.equal(logs.join("").includes(walletToken), false);
    assert.equal(logs.join("").includes(token), false);
    t.diagnostic(
      "Two actual Bun listeners; nine create methods plus HEAD and SSR-only context; retained identity/session/cache/counter parity. Unconfigured Blob/provider paths refuse; no chain execution. CPU sample is a local overlap measurement, not a production SLO.",
    );
  },
);
