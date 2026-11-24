// HTTP status of the permanent coin route on a running server. The file starts
// indexed fixtures, the native backend, and a production web build/server, with
// the launchpad and its parent social shell enabled, and stops them at the end.
// To test servers you already run, set
// COIN_ROUTE_ORIGIN and COIN_FIXTURE_ORIGIN. From the root:
//   npm run test:integration -w @blast/web -- 'src/app/(launchpad)/coin/coin-route.integration.test.ts'
// It proves the page decides a missing coin's status before streaming any
// slot: a real HTTP 404, not a soft 404 inside a 200.

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { JSDOM } from "jsdom";

import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

import { FIXTURE_FINGERPRINT, FIXTURE_NETWORK } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";

import {
  FOREIGN_OBJECT_ID,
  startCoinFixtureServer,
  type CoinFixtureServer,
} from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixture-server.ts";
import { COIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/launchpad-coin/fixtures.ts";
import { capacityFixture } from "../../../../../backend-api/test/capacity-fixture.ts";
import { partnerVerifierFixture, runtimeRoleFixture } from "../../../../../backend-api/test/partner-verifier-fixture.ts";
import { RUNTIME_TEST_ENVIRONMENT } from "../../../../../../packages/server/test/fixtures/config/runtime-config.ts";

const WEB = new URL("../../../../", import.meta.url);
let origin = process.env.COIN_ROUTE_ORIGIN;
let fixtures = process.env.COIN_FIXTURE_ORIGIN;
const externalServers = Boolean(origin && fixtures);
let fixtureServer: CoinFixtureServer | undefined;
let app: ChildProcess | undefined;
let backend: ChildProcess | undefined;
let appOutput = "";
let backendOutput = "";
const databaseRoleCleanups: (() => Promise<void>)[] = [];
const databaseRoles = {
  after(cleanup: () => Promise<void>) {
    databaseRoleCleanups.push(cleanup);
  },
};
// This loopback fixture represents the platform that overwrites this header.
const platformHeaders = { "x-vercel-forwarded-for": "192.0.2.1" };
const SALE_TYPE = `0x${"12".repeat(32)}::sale::SALE`;
const SALE_ID = `0x${"24".repeat(32)}`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer().once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  if (externalServers) {
    return;
  }
  const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
  const redisUrl = process.env.BLAST_TEST_REDIS_URL;
  assert.ok(databaseUrl, "the coin HTTP suite needs the disposable test database");
  assert.ok(redisUrl, "the coin HTTP suite needs disposable quota Redis");
  assert.equal(new URL(databaseUrl).hostname, "127.0.0.1");
  assert.equal(new URL(redisUrl).hostname, "127.0.0.1");
  const admin = createPool(databaseUrl);
  try {
    await migrateDatabase(admin);
    const curvePool = `blast_curve:${COIN_FIXTURE.launchId}`;
    // The launch is discoverable by type before its coin metadata reaches the replica.
    await admin.query(
      "INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms) VALUES ($1, 'blast_curve', $2, $3, 'migrated', 900, 1790000000000)",
      [curvePool, COIN_FIXTURE.coinType, SUI_COIN_TYPE],
    );
    await admin.query(
      `INSERT INTO blast_infra_fixture.presales
        (presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals, quote_symbol, quote_decimals,
         lifecycle, start_ms, end_ms, raise_target, min_commitment, total_commitments, participants, venue, pool_id, updated_checkpoint)
       VALUES ($1, $2, $3, 'SALE', 'Fixture Sale', 'https://example.com/sale.png', 9, 'SUI', 9, 'migrated', 0, 1, 1, 1, 1, 1, 'bluefin', 'pool', 1)`,
      [SALE_ID, SALE_TYPE, SUI_COIN_TYPE],
    );
  } finally {
    await admin.end();
  }
  const apiKey = randomBytes(32).toString("hex");
  // The API checks blast-infra's provenance against its deployment, which is always on mainnet.
  fixtureServer = await startCoinFixtureServer({ apiKey, network: FIXTURE_NETWORK });
  fixtures = fixtureServer.origin;
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const backendPort = await freePort();
  const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    TURBO_TASKS_AVAILABLE_PARALLELISM: "1",
    VERCEL: "1",
    BLAST_DEPLOYMENT_TARGET: "preview",
    BLAST_DEPLOYMENT_BRANCH: "coin-route-local-fixture",
    NEXT_PUBLIC_SITE_URL: origin,
    BLAST_BACKEND_API_ORIGIN: `http://127.0.0.1:${backendPort}`,
    BLAST_BACKEND_GATEWAY_SECRET: randomBytes(32).toString("hex"),
    BLAST_QUOTA_REDIS_URL: redisUrl,
    BLAST_REDIS_NAMESPACE: `coin-route:${randomBytes(16).toString("hex")}`,
    BLAST_BACKEND_INGRESS_MODE: "direct",
    BLAST_BACKEND_LISTEN_HOST: "127.0.0.1",
    BLAST_PARTNER_CAPACITY_CONFIG: capacityFixture(["coin-route-fixture"]),
    PARTNER_VERIFIER_DATABASE_URL: await partnerVerifierFixture(databaseUrl, databaseRoles),
    BLAST_LAUNCHPAD_ENABLED: "true",
    BLAST_PRESALE_ENABLED: "true",
    BLAST_SOCIAL_ENABLED: "true",
    // The web build has no released signing chain or live fullnode.
    BLAST_NETWORK: "",
    BLAST_DEPLOYMENT_FINGERPRINT: "",
    BLAST_INFRA_ORIGIN: fixtures,
    BLAST_INFRA_API_KEY: apiKey,
    BLAST_GATE_SECRET: randomBytes(32).toString("hex"),
    BLAST_GATE_SECRET_PREVIOUS: "",
    RATE_LIMIT_SUBJECT_PEPPER: randomBytes(32).toString("hex"),
    DATABASE_URL: await runtimeRoleFixture(databaseUrl, databaseRoles, "blast_web"),
    DATABASE_REPLICA_URL: await runtimeRoleFixture(databaseUrl, databaseRoles, "blast_replica"),
  };
  backend = spawn(
    "bun",
    ["--no-env-file", new URL("../../../../../backend-api/src/main.ts", import.meta.url).pathname],
    {
      env: {
        // The backend alone boots on the runtime config; the web build must not see its Privy fixture.
        ...RUNTIME_TEST_ENVIRONMENT,
        ...env,
        // The API requires its deployment: the released network, and the fixtures' fingerprint.
        BLAST_NETWORK: FIXTURE_NETWORK,
        BLAST_DEPLOYMENT_FINGERPRINT: FIXTURE_FINGERPRINT,
        // Fresh reads go to a loopback port nothing listens on, never the public fullnode.
        PRESALE_SUI_GRPC_URL: `https://127.0.0.1:${await freePort()}`,
        NODE_ENV: "test",
        PORT: String(backendPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const captureBackend = (chunk: Buffer) => {
    backendOutput = (backendOutput + chunk.toString()).slice(-4_000);
  };
  backend.stdout!.on("data", captureBackend);
  backend.stderr!.on("data", captureBackend);
  await waitForServer(
    backend,
    env.BLAST_BACKEND_API_ORIGIN!,
    "/v1/health",
    200,
    () => backendOutput,
  );
  await promisify(execFile)(process.execPath, [next, "build"], {
    cwd: WEB,
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  app = spawn(
    process.execPath,
    [next, "start", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: WEB,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    },
  );
  const capture = (chunk: Buffer) => {
    appOutput = (appOutput + chunk.toString()).slice(-4_000);
  };
  app.stdout!.on("data", capture);
  app.stderr!.on("data", capture);
  await waitForServer(app, origin, "/landing/blast-logo.svg", 200, () => appOutput);
});

after(async () => {
  await Promise.all([stopProcess(app, true), stopProcess(backend)]);
  await fixtureServer?.close();
  await Promise.all(databaseRoleCleanups.map((cleanup) => cleanup()));
});

async function stopProcess(child: ChildProcess | undefined, group = false) {
  if (!child?.pid || child.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signal = (value: NodeJS.Signals) =>
    group ? process.kill(-child.pid!, value) : child.kill(value);
  signal("SIGTERM");
  const deadline = setTimeout(() => signal("SIGKILL"), 5_000);
  await exited;
  clearTimeout(deadline);
}

async function waitForServer(
  child: ChildProcess,
  base: string,
  path: string,
  status: number,
  output: () => string,
) {
  for (
    const deadline = Date.now() + 120_000;
    ;
    await new Promise((resolve) => setTimeout(resolve, 500))
  ) {
    const ready = await fetch(new URL(path, base), {
      headers: platformHeaders,
      signal: AbortSignal.timeout(5_000),
    }).then(
      async (response) => {
        await response.body?.cancel();
        return response.status === status;
      },
      () => false,
    );
    if (ready) {
      return;
    }
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`Server did not answer on ${base}: ${output()}`);
    }
  }
}

async function setState(patch: Record<string, string>) {
  const response = await fetch(new URL("/__fixture/state", fixtures), {
    method: "POST",
    body: JSON.stringify(patch),
  });
  assert.equal(response.status, 200);
}

async function get(path: string) {
  const response = await fetch(new URL(path, origin), {
    redirect: "manual",
    headers: platformHeaders,
  });
  assert.notEqual(response.status, 500, appOutput + backendOutput);
  return { status: response.status, html: await response.text() };
}

test("unknown, foreign and malformed launch IDs answer HTTP 404", async () => {
  await setState({ indexed: "live", fresh: "live", infra: "ok", venue: "ok" });
  for (const id of [
    COIN_FIXTURE.unknownLaunchId,
    FOREIGN_OBJECT_ID,
    "0x2",
    COIN_FIXTURE.launchId.toUpperCase(),
  ]) {
    const { status, html } = await get(`/coin/${id}`);
    assert.equal(status, 404, id);
    const doc = JSDOM.fragment(html);
    const robots = [...doc.querySelectorAll('meta[name="robots"]')].map((meta) => meta.getAttribute("content"));
    assert.ok(robots.some((content) => /\bnoindex\b/.test(content ?? "")), id);
    assert.equal(doc.querySelector("[data-bonding-coin]"), null, id);
  }
});

test("the known launch answers HTTP 200 at every lifecycle and through an outage", async () => {
  for (const lifecycle of ["opening_round", "live", "migration_ready", "migrated"]) {
    await setState({ indexed: lifecycle, fresh: lifecycle, infra: "ok", venue: "ok" });
    const { status, html } = await get(`/coin/${COIN_FIXTURE.launchId}`);
    assert.equal(status, 200, lifecycle);
    assert.equal(JSDOM.fragment(html).querySelector("h1")?.textContent, "$FROGGY", lifecycle);
  }
  await setState({ infra: "down" });
  assert.equal((await get(`/coin/${COIN_FIXTURE.launchId}`)).status, 200);
  await setState({ indexed: "live", fresh: "live", infra: "ok", venue: "ok" });
});

test("a tag URL resolves a migrated Blast launch, a migrated presale, and Sui", {
  skip: externalServers && "requires the local identity database fixtures",
}, async () => {
  await setState({ indexed: "migrated", fresh: "migrated", infra: "ok", venue: "ok" });
  const launchPath = `/coin/${encodeURIComponent(COIN_FIXTURE.coinType)}`;
  const launch = await get(launchPath + "?interval=1h&range=7d");
  assert.equal(launch.status, 200);
  assert.equal(JSDOM.fragment(launch.html).querySelector("h1")?.textContent, "$FROGGY");
  const legacy = await get(`/coin/${COIN_FIXTURE.launchId}`);
  assert.equal(legacy.status, 200);
  assert.ok(JSDOM.fragment(legacy.html).querySelector('link[rel="canonical"]')?.getAttribute("href")?.endsWith(launchPath));

  const sale = await fetch(new URL(`/coin/${encodeURIComponent(SALE_TYPE)}?from=home`, origin), { headers: platformHeaders, redirect: "manual" });
  assert.equal(sale.status, 307);
  assert.equal(sale.headers.get("location"), `/presale/${SALE_ID}?from=home`);
  await sale.body?.cancel();

  const saleAlias = await fetch(new URL(`/coin/${SALE_ID}?from=home&tab=sale&tab=claims&ref=`, origin), { headers: platformHeaders, redirect: "manual" });
  assert.equal(saleAlias.status, 307);
  assert.equal(saleAlias.headers.get("location"), `/presale/${SALE_ID}?from=home&tab=sale&tab=claims&ref=`);
  await saleAlias.body?.cancel();

  const sui = await get("/coin/0x2%3A%3Asui%3A%3ASUI");
  assert.equal(sui.status, 200);
  assert.equal(JSDOM.fragment(sui.html).querySelector("h1")?.textContent, "Sui");
});

test("in a total outage an unconfirmed ID answers 200 noindex with no source label", async () => {
  await setState({ indexed: "live", fresh: "down", infra: "down", venue: "ok" });
  try {
    const { status, html } = await get(`/coin/${COIN_FIXTURE.unknownLaunchId}`);
    assert.equal(status, 200);
    assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
    const coin = JSDOM.fragment(html).querySelector("[data-bonding-coin]");
    assert.ok(coin);
    assert.match(coin.querySelector('[role="alert"]')?.textContent ?? "", /Launch could not be confirmed/);
    assert.match(coin.querySelector("[data-page-head]")?.textContent ?? "", /Unconfirmed/);
    assert.equal(coin.querySelector('[role="alert"] a')?.getAttribute("href"), `/coin/${COIN_FIXTURE.unknownLaunchId}`);
    assert.equal(coin.querySelector('[aria-label="Launch progress"]'), null);
  } finally {
    await setState({ indexed: "live", fresh: "live", infra: "ok", venue: "ok" });
  }
});

test("WP2: the browser's market reads go through the app; the page and its CSP name no blast-infra origin", async () => {
  await setState({ indexed: "live", fresh: "live", infra: "ok", venue: "ok", holders: "complete" });
  const page = await fetch(new URL(`/coin/${COIN_FIXTURE.launchId}`, origin), {
    headers: platformHeaders,
  });
  assert.equal(page.status, 200, appOutput + backendOutput);
  const csp = page.headers.get("content-security-policy") ?? "";
  const html = await page.text();
  const infraHost = new URL(fixtures!).host;
  assert.ok(!csp.includes(infraHost), csp);
  assert.ok(!html.includes(infraHost), "the page hands the browser no blast-infra origin");
  // The page load issues the API gate cookie (docs/security/bot-protection.md); a browser sends it back.
  const headers = {
    ...platformHeaders,
    cookie: page.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  };
  const ungated = await fetch(
    new URL(
      `/api/launchpad/market/coins/${COIN_FIXTURE.coinType}/holders?view=snapshot&limit=25`,
      origin,
    ),
    { headers: platformHeaders },
  );
  assert.equal(
    ungated.status,
    401,
    "the production API gate still refuses a request without its signed cookie",
  );
  const relayed = await fetch(
    new URL(
      `/api/launchpad/market/coins/${COIN_FIXTURE.coinType}/holders?view=snapshot&limit=25`,
      origin,
    ),
    { headers },
  );
  assert.equal(relayed.status, 200);
  assert.match(relayed.headers.get("cache-control") ?? "", /^public, max-age=0, s-maxage=5/);
  assert.equal(((await relayed.json()) as { coin: string }).coin, COIN_FIXTURE.coinType);
  const refused = await fetch(
    new URL(
      `/api/launchpad/market/coins/${COIN_FIXTURE.coinType}/holders?view=snapshot&sort=x`,
      origin,
    ),
    { headers },
  );
  assert.equal(refused.status, 400);
});
