import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";

import pg, { type Pool } from "pg";

import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createPool, migrateDatabase } from "@blast/core/modules/database/admin.ts";
import { createRuntimePool, type PoolSettings } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { COIN_VIEW_EVENT, LaunchpadTelemetryRejection } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import { LAUNCHPAD_TELEMETRY_TIMEOUT_MS, createLaunchpadTelemetryEmitter } from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import { LAUNCHPAD_STORAGE_TIMEOUTS, telemetryShare } from "@blast/server/modules/launchpad-telemetry/gate.ts";
import { NON_PRODUCTION_MANIFEST } from "../../../../core/test/fixtures/modules/launchpad-coin/manifest-fixtures.ts";
import { OUTCOME_FIXTURE, createOutcomeFixtureNode } from "../../../../core/test/fixtures/modules/launchpad-telemetry/outcome-fixtures.ts";
import { createLaunchpadOutcomeCommitmentRouteHandler, createLaunchpadOutcomeRouteHandler, createOutcomeVerifier } from "@blast/server/modules/launchpad-telemetry/outcomes.ts";
import { VISITOR_COOKIE_NAME, createLaunchpadTelemetryRouteHandler } from "@blast/server/modules/launchpad-telemetry/route.ts";
import { LaunchpadTelemetryRepository } from "@blast/server/modules/launchpad-telemetry/repository.ts";
import { LaunchpadTelemetryService } from "@blast/server/modules/launchpad-telemetry/service.ts";

import { runCleanup } from "@blast/server/modules/mission-control/maintenance/service.ts";
import { testClient } from "../../../../core/test/fixtures/lib/web-security/client-address.ts";

process.env.MISSION_CONTROL_METRICS = "off";

const MIGRATIONS = new URL("../../../../core/src/modules/database/migrations/", import.meta.url);

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

const ORIGIN = "https://blast.fun";
/** The coin page verifies tradability; these tests are about storage, so every coin is tradable. */
const TRADABLE = async () => "tradable" as const;
const PEPPER = "launchpad-telemetry-test-pepper-of-32-characters";
const COIN_A = `0x${"a1".repeat(32)}`;
const COIN_B = `0x${"b2".repeat(32)}`;
const VISITOR_ONE = "11111111-1111-4111-8111-111111111111";
const VISITOR_TWO = "22222222-2222-4222-8222-222222222222";
const VISITOR_THREE = "33333333-3333-4333-8333-333333333333";
/** A completed event's native sender, as the chain reports it. */
const SENDER = `0x${"c0".repeat(32)}`;

/** A Base58 digest unique to this suite (other suites share the database). */
function digest(label: string): string {
  return `LaunchpadDigestSuite${label}`.padEnd(44, "z");
}
const DIGEST_ONE = digest("A");
const DIGEST_TWO = digest("B");
const DIGEST_THREE = digest("C");

function view(launchId: string) {
  return { event: COIN_VIEW_EVENT, launchId, surface: "coin-page" };
}

function completed(txDigest: string, completedAt: string) {
  return { status: "completed", checkpoint: 326_274_009, txDigest, eventSeq: 0, completedAt };
}

/** The production pool defaults (pool.ts), with a small pool to make contention visible. */
const PRODUCTION_LIKE: PoolSettings = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 15_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 3_000,
  max: 2,
  statementTimeoutMs: 8_000,
};

async function clear(admin: Pool): Promise<void> {
  await admin.query("DELETE FROM mission_control_launchpad_coin_views");
  await admin.query("DELETE FROM mission_control_launchpad_outcomes");
  await admin.query("DELETE FROM mission_control_launchpad_outcome_commitments");
  await admin.query(
    "DELETE FROM mission_control_rate_limit_windows WHERE policy_name IN ('launchpad_telemetry', 'launchpad_outcome', 'launchpad_outcome_commitment')",
  );
}

/** Runs `body` with a migrated, cleared database and a web-runtime pool; clears again afterwards. */
async function withDatabase(
  body: (pools: { admin: Pool; web: Pool }) => Promise<void>,
  settings: PoolSettings = { ...PRODUCTION_LIKE, connectionTimeoutMs: 2_000 },
  applicationName = "launchpad-telemetry-suite",
): Promise<void> {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 3 });
  // The service runs as the web runtime role, as in production.
  const web = createRuntimePool(urlAs(databaseUrl, "blast_web"), settings, applicationName);
  try {
    await migrateDatabase(admin);
    await clear(admin);
    await body({ admin, web });
  } finally {
    await clear(admin).catch(() => undefined);
    await Promise.all([admin.end(), web.end()]);
  }
}

function service(web: Pool, clock?: () => Date): LaunchpadTelemetryService {
  return new LaunchpadTelemetryService(web, {
    clock,
    limiter: new PostgresRateLimitEnforcer({
      pool: web,
      subjectPepper: PEPPER,
      clock,
      timeouts: LAUNCHPAD_STORAGE_TIMEOUTS,
    }),
  });
}

test("a visitor's first view of a tradable coin is recorded once per reporting period", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    let now = new Date("2026-09-30T09:00:00.000Z");
    const telemetry = new LaunchpadTelemetryService(web, { clock: () => now });

    assert.equal(await telemetry.recordCoinView(VISITOR_ONE, view(COIN_A)), "recorded");
    now = new Date("2026-09-30T21:00:00.000Z");
    assert.equal(await telemetry.recordCoinView(VISITOR_ONE, view(COIN_A)), "duplicate");
    assert.equal(await telemetry.recordCoinView(VISITOR_ONE, view(COIN_B)), "recorded");
    assert.equal(await telemetry.recordCoinView(VISITOR_TWO, view(COIN_A)), "recorded");
    now = new Date("2026-10-01T00:00:00.000Z");
    assert.equal(await telemetry.recordCoinView(VISITOR_ONE, view(COIN_A)), "recorded");

    // Only the opaque visitor, the coin, the period and the bounded surface are stored.
    const stored = await admin.query(
      `SELECT period_start::text, visitor_id::text, launch_id, surface, viewed_at
       FROM mission_control_launchpad_coin_views
       WHERE visitor_id = $1 AND launch_id = $2 ORDER BY period_start`,
      [VISITOR_ONE, COIN_A],
    );
    assert.deepEqual(stored.rows, [
      {
        period_start: "2026-09-30",
        visitor_id: VISITOR_ONE,
        launch_id: COIN_A,
        surface: "coin-page",
        viewed_at: new Date("2026-09-30T09:00:00.000Z"),
      },
      {
        period_start: "2026-10-01",
        visitor_id: VISITOR_ONE,
        launch_id: COIN_A,
        surface: "coin-page",
        viewed_at: new Date("2026-10-01T00:00:00.000Z"),
      },
    ]);

    const funnel = await telemetry.funnel({ from: "2026-09-30", to: "2026-10-01" });
    assert.deepEqual(
      funnel.map(({ periodStart, firstViews, viewers }) => ({ periodStart, firstViews, viewers })),
      [
        { periodStart: "2026-09-30", firstViews: 3, viewers: 2 },
        { periodStart: "2026-10-01", firstViews: 1, viewers: 1 },
      ],
    );

    // Private or malformed input is refused before storage.
    await assert.rejects(
      telemetry.recordCoinView(`0x${"c0".repeat(32)}`, view(COIN_A)),
      LaunchpadTelemetryRejection,
    );
    await assert.rejects(
      telemetry.recordCoinView(VISITOR_TWO, { ...view(COIN_B), wallet: `0x${"c0".repeat(32)}` }),
      LaunchpadTelemetryRejection,
    );
    const count = await admin.query("SELECT count(*)::int AS n FROM mission_control_launchpad_coin_views");
    assert.equal(count.rows[0]?.n, 4);
  });
});

test("aggregates join first views only to verified completed outcomes", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    let now = new Date("2026-09-30T10:00:00.000Z");
    const telemetry = new LaunchpadTelemetryService(web, { clock: () => now });
    await telemetry.recordCoinView(VISITOR_ONE, view(COIN_A));
    await telemetry.recordCoinView(VISITOR_TWO, view(COIN_A));

    // Visitor one buys after the view: a conversion. A retried record is not a second one.
    const linked = { senderWallet: SENDER, visitorLink: "privy_session" };
    const buy = { kind: "buy", launchId: COIN_A, visitorId: VISITOR_ONE, ...linked, completion: completed(DIGEST_ONE, "2026-09-30T10:05:00.000Z") };
    assert.equal(await telemetry.recordOutcome(buy), "recorded");
    assert.equal(await telemetry.recordOutcome(buy), "duplicate");
    // Visitor two's buy completed before their first view: counted, not attributed.
    assert.equal(
      await telemetry.recordOutcome({ kind: "buy", launchId: COIN_A, visitorId: VISITOR_TWO, ...linked, completion: completed(DIGEST_TWO, "2026-09-30T09:59:59.000Z") }),
      "recorded",
    );
    // A completion without a visitor counts but joins nothing.
    assert.equal(
      await telemetry.recordOutcome({ kind: "migration", launchId: COIN_A, senderWallet: SENDER, visitorId: null, completion: completed(DIGEST_THREE, "2026-09-30T11:00:00.000Z") }),
      "recorded",
    );
    // Clicks, simulations, signatures and submitted digests are never recorded.
    for (const status of ["clicked", "simulated", "signed", "submitted"]) {
      await assert.rejects(
        telemetry.recordOutcome({
          kind: "launch",
          launchId: COIN_B,
          visitorId: VISITOR_TWO,
          ...linked,
          completion: { ...completed(DIGEST_THREE, "2026-09-30T11:00:00.000Z"), status },
        }),
        LaunchpadTelemetryRejection,
      );
    }
    await assert.rejects(
      telemetry.recordOutcome({ kind: "launch", launchId: COIN_B, visitorId: VISITOR_TWO, ...linked, completion: { status: "submitted", txDigest: DIGEST_THREE } }),
      LaunchpadTelemetryRejection,
    );

    now = new Date("2026-10-02T00:00:00.000Z");
    const [period] = await telemetry.funnel({ from: "2026-09-30", to: "2026-09-30" });
    assert.deepEqual(period, {
      periodStart: "2026-09-30",
      firstViews: 2,
      viewers: 2,
      outcomes: {
        buy: { completed: 2, convertedViewers: 1 },
        launch: { completed: 0, convertedViewers: 0 },
        migration: { completed: 1, convertedViewers: 0 },
      },
    });
    const stored = await admin.query("SELECT count(*)::int AS n FROM mission_control_launchpad_outcomes");
    assert.equal(stored.rows[0]?.n, 3);

    await assert.rejects(telemetry.funnel({ from: "2026-10-01", to: "2026-09-30" }), TypeError);
    await assert.rejects(telemetry.funnel({ from: "2025-01-01", to: "2026-09-30" }), TypeError);
  });
});

function beacon(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/launchpad/telemetry`, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: ORIGIN, ...headers },
  });
}

test("working path: one tradable coin rendered twice is one first view; telemetry outage leaves the product action alone", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    // The same database behind an endpoint that refuses connections.
    const unavailable = createRuntimePool("postgres://blast_web@127.0.0.1:1/unavailable", {
      ...PRODUCTION_LIKE,
      connectionTimeoutMs: 500,
    });
    try {
      const handler = createLaunchpadTelemetryRouteHandler({
        expectedOrigin: ORIGIN,
        verifyTradable: TRADABLE,
        emitter: createLaunchpadTelemetryEmitter(() => service(web)),
      });
      const first = await handler(beacon(view(COIN_A)), testClient());
      assert.equal(first.status, 204);
      const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
      assert.match(cookie, new RegExp(`^${VISITOR_COOKIE_NAME}=[0-9a-f-]{36}$`));
      // The page is rendered again (a reload): the same visitor reports the same coin.
      const again = await handler(beacon(view(COIN_A), { Cookie: cookie }), testClient());
      assert.equal(again.status, 204);
      // Malformed and private-label attempts are refused.
      assert.equal((await handler(beacon("{", { Cookie: cookie }), testClient())).status, 400);
      assert.equal((await handler(beacon({ ...view(COIN_A), surface: `0x${"c0".repeat(32)}` }, { Cookie: cookie }), testClient())).status, 400);
      assert.equal((await handler(beacon({ ...view(COIN_A), privySubject: "did:privy:cm0abc" }, { Cookie: cookie }), testClient())).status, 400);

      const rows = await admin.query<{ visitor_id: string; launch_id: string; surface: string }>(
        "SELECT visitor_id::text, launch_id, surface FROM mission_control_launchpad_coin_views",
      );
      assert.deepEqual(rows.rows, [
        { visitor_id: cookie.split("=")[1], launch_id: COIN_A, surface: "coin-page" },
      ]);

      // Telemetry storage is down: the beacon gets a bounded 503 ...
      const down = createLaunchpadTelemetryEmitter(() => service(unavailable));
      const started = performance.now();
      const outage = await createLaunchpadTelemetryRouteHandler({ expectedOrigin: ORIGIN, verifyTradable: TRADABLE, emitter: down })(
        beacon(view(COIN_B), { Cookie: cookie }), testClient(),
      );
      assert.equal(outage.status, 503);
      assert.ok(performance.now() - started < LAUNCHPAD_TELEMETRY_TIMEOUT_MS + 500);

      // ... and a representative product action (a read on the product's pool that
      // then reports its verified buy) returns the same answer whether or not
      // telemetry is up, even though it awaits it.
      async function completeBuy(telemetry: typeof down, txDigest: string): Promise<number> {
        const answer = await web.query<{ ok: number }>("SELECT 1 AS ok");
        await telemetry.recordOutcome({
          kind: "buy",
          launchId: COIN_A,
          senderWallet: SENDER,
          visitorId: null,
          completion: completed(txDigest, "2026-09-30T12:00:00.000Z"),
        });
        return answer.rows[0]?.ok ?? -1;
      }
      const withOutage = await completeBuy(down, DIGEST_ONE);
      const withTelemetry = await completeBuy(createLaunchpadTelemetryEmitter(() => service(web)), DIGEST_TWO);
      assert.equal(withOutage, 1);
      assert.equal(withTelemetry, withOutage);
      // A malformed optional record does not alter the action either.
      assert.equal(await down.recordOutcome({ kind: "buy", status: "submitted" }), "rejected");
    } finally {
      await unavailable.end();
    }
  });
});

test("P5: a product read on the telemetry's pool succeeds while telemetry storage is locked", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    const locker = await admin.connect();
    try {
      // Storage is slow: a migration (say) holds both telemetry tables.
      await locker.query("BEGIN");
      await locker.query(
        "LOCK TABLE mission_control_launchpad_coin_views, mission_control_launchpad_outcomes IN ACCESS EXCLUSIVE MODE",
      );
      const emitter = createLaunchpadTelemetryEmitter(() => new LaunchpadTelemetryService(web));
      const started = performance.now();
      const beacons = Promise.all([
        emitter.recordCoinView(VISITOR_ONE, view(`0x${"01".repeat(32)}`)),
        emitter.recordCoinView(VISITOR_TWO, view(`0x${"02".repeat(32)}`)),
        emitter.recordCoinView(VISITOR_ONE, view(`0x${"03".repeat(32)}`)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The product's table-free read on the same pool (max 2) while beacons are in flight.
      const product = performance.now();
      const answer = await web.query<{ ok: number }>("SELECT 1 AS ok");
      assert.deepEqual(answer.rows, [{ ok: 1 }]);
      assert.ok(performance.now() - product < 500, `product read took ${Math.round(performance.now() - product)} ms`);

      assert.deepEqual(await beacons, ["dropped", "dropped", "dropped"]);
      const elapsed = performance.now() - started;
      assert.ok(elapsed < LAUNCHPAD_TELEMETRY_TIMEOUT_MS + 300, `beacons took ${Math.round(elapsed)} ms`);
      // The locked statement ended on the server at the storage budget, not the pool's.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(web.waitingCount, 0);
      assert.ok(LAUNCHPAD_STORAGE_TIMEOUTS.statementTimeoutMs < LAUNCHPAD_TELEMETRY_TIMEOUT_MS);
      await locker.query("COMMIT");
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    // Once storage recovers, telemetry records again.
    const recovered = createLaunchpadTelemetryEmitter(() => new LaunchpadTelemetryService(web));
    assert.equal(await recovered.recordCoinView(VISITOR_ONE, view(COIN_A)), "recorded");
  });
});

test("a burst from one client beyond the launchpad_telemetry bucket records nothing more", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    const now = new Date("2026-09-30T12:00:30.000Z");
    const handler = createLaunchpadTelemetryRouteHandler({
      expectedOrigin: ORIGIN,
      verifyTradable: TRADABLE,
      emitter: createLaunchpadTelemetryEmitter(() => service(web, () => now)),
    });
    const statuses: Record<number, number> = {};
    for (let request = 0; request < 40; request += 1) {
      // A script with no cookie and a new shape-valid launch ID each time.
      const launchId = `0x${request.toString(16).padStart(2, "0").repeat(32)}`;
      const response = await handler(beacon(view(launchId)), testClient());
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      if (response.status === 429) assert.equal(response.headers.get("set-cookie"), null);
    }
    assert.deepEqual(statuses, { 204: 30, 429: 10 });
    const stored = await admin.query<{ n: number; visitors: number }>(
      "SELECT count(*)::int AS n, count(DISTINCT visitor_id)::int AS visitors FROM mission_control_launchpad_coin_views",
    );
    assert.deepEqual(stored.rows[0], { n: 30, visitors: 30 });
    // Another client still reports.
    assert.equal((await handler(beacon(view(COIN_A)), testClient("198.51.100.2"))).status, 204);
  });
});

test("B-008: a telemetry lock held for several budgets leaves no telemetry backends beyond the gate and nothing commits late", { skip }, async () => {
  const applicationName = "launchpad-telemetry-b008";
  const settings = { ...PRODUCTION_LIKE, max: 10 };
  await withDatabase(async ({ admin, web }) => {
    assert.ok(databaseUrl);
    const share = telemetryShare(web);
    assert.equal(share, 2);
    const handler = createLaunchpadTelemetryRouteHandler({
      expectedOrigin: ORIGIN,
      verifyTradable: TRADABLE,
      emitter: createLaunchpadTelemetryEmitter(() => service(web)),
    });
    const telemetryBackends = async () =>
      (await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND state <> 'idle'",
        [applicationName],
      )).rows[0]?.n ?? -1;

    const locker = await admin.connect();
    const statuses: Record<number, number> = {};
    let most = 0;
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE mission_control_launchpad_coin_views IN ACCESS EXCLUSIVE MODE");
      // Beacons keep arriving for four storage budgets while the table stays locked.
      const until = performance.now() + 4 * LAUNCHPAD_STORAGE_TIMEOUTS.statementTimeoutMs;
      let sent = 0;
      while (performance.now() < until) {
        const batch = Array.from({ length: 5 }, () => {
          sent += 1;
          return handler(beacon(view(`0x${sent.toString(16).padStart(64, "0")}`)), testClient(`198.51.100.${sent % 250}`)).then((response) => {
            statuses[response.status] = (statuses[response.status] ?? 0) + 1;
          });
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        most = Math.max(most, await telemetryBackends());
        await Promise.all(batch);
      }
      assert.ok(most <= share, `at most ${share} telemetry backends at a time, saw ${most}`);
      assert.deepEqual(Object.keys(statuses), ["503"], JSON.stringify(statuses));

      // A new product connection and a product read on the telemetry's pool both succeed.
      const fresh = new pg.Client({ connectionString: urlAs(databaseUrl, "blast_web") });
      await fresh.connect();
      assert.deepEqual((await fresh.query("SELECT 1 AS ok")).rows, [{ ok: 1 }]);
      await fresh.end();
      assert.deepEqual((await web.query("SELECT 1 AS ok")).rows, [{ ok: 1 }]);
      assert.equal(await telemetryBackends(), 0, "no telemetry statement outlives its budget");
      await locker.query("COMMIT");
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    // Beacons answered 503 never commit after the unlock.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stored = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM mission_control_launchpad_coin_views");
    assert.equal(stored.rows[0]?.n, 0);
  }, settings, applicationName);
});

function outcomeReport(body: unknown, cookie: string | null = `${VISITOR_COOKIE_NAME}=${VISITOR_ONE}`): Request {
  return new Request(`${ORIGIN}/api/launchpad/outcomes`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Origin: ORIGIN,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

test("working path: verified launch and Buy reports record one outcome each for the event sender; links follow only Privy and one on-time commitment", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    const node = createOutcomeFixtureNode();
    const { launchId, digests, senders } = OUTCOME_FIXTURE;
    // Commitments arrive two seconds before the fixture checkpoint; reports after it.
    const emitter = createLaunchpadTelemetryEmitter(() => service(web, () => new Date(OUTCOME_FIXTURE.timestampMs - 2_000)));
    const privySessions: Record<string, string> = { "token-buyer": senders.buyer, "token-creator": senders.creator };
    const handler = createLaunchpadOutcomeRouteHandler({
      expectedOrigin: ORIGIN,
      verify: createOutcomeVerifier(async () => ({ client: node.client, manifest: NON_PRODUCTION_MANIFEST })),
      emitter,
      verifyPrivySession: async (token) => {
        if (token === "token-down") throw Object.assign(new Error("privy down"), { code: "PROVIDER_UNAVAILABLE" });
        if (!privySessions[token]) throw Object.assign(new Error("invalid"), { code: "INVALID_ACCESS_TOKEN" });
        return { suiWalletAddress: privySessions[token] };
      },
    });
    const commitments = createLaunchpadOutcomeCommitmentRouteHandler({
      expectedOrigin: ORIGIN,
      emitter,
      // Commitments arrive two seconds before the fixture checkpoint.
      clock: () => new Date(OUTCOME_FIXTURE.timestampMs - 2_000),
    });
    const statuses: Array<[string, number, unknown]> = [];
    async function send(label: string, request: Request, route = handler) {
      const response = await route(request, testClient());
      statuses.push([label, response.status, await response.json()]);
    }
    const cookie = (visitor: string) => `${VISITOR_COOKIE_NAME}=${visitor}`;
    const commit = (body: unknown, visitor: string | null) => {
      const request = outcomeReport(body, visitor && cookie(visitor));
      return new Request(`${ORIGIN}/api/launchpad/outcomes/commitments`, { method: "POST", headers: request.headers, body: JSON.stringify(body) });
    };
    const launch = { kind: "launch", launchId, txDigest: digests.launch };
    const buy = { kind: "buy", launchId, txDigest: digests.buy };
    const bidderBuy = { kind: "buy", launchId, txDigest: digests.settlementThenBuy };

    // The creator's browser commits its launch before submission; two browsers commit the same Buy.
    await send("commit launch", commit(launch, VISITOR_ONE), commitments);
    await send("commit launch again", commit(launch, VISITOR_ONE), commitments);
    await send("commit buy", commit(buy, VISITOR_ONE), commitments);
    await send("commit buy, another visitor", commit(buy, VISITOR_TWO), commitments);
    await send("commit without a visitor", commit(bidderBuy, null), commitments);
    // Another visitor reports the launch first: attribution is still the sender's, linked to the committer.
    await send("launch by another visitor", outcomeReport(launch, cookie(VISITOR_TWO)));
    await send("launch again", outcomeReport(launch));
    // The contested Buy is recorded wallet-only; the buyer's own Privy session later links its visitor.
    await send("buy, no cookie", outcomeReport(buy, null));
    await send("buy, buyer's Privy session", withToken(outcomeReport(buy, cookie(VISITOR_THREE)), "token-buyer"));
    await send("buy, creator's Privy session", withToken(outcomeReport(buy, cookie(VISITOR_TWO)), "token-creator"));
    // Privy for another wallet or a Privy outage: recorded without a link.
    await send("bidder buy, other wallet's session", withToken(outcomeReport(bidderBuy, cookie(VISITOR_TWO)), "token-creator"));
    await send("bidder buy, Privy down", withToken(outcomeReport(bidderBuy, cookie(VISITOR_THREE)), "token-down"));
    for (const [label, txDigest] of [
      ["settlement", digests.settlement],
      ["sold", digests.sold],
      ["failed", digests.failed],
      ["unknown", digests.unknown],
      ["foreign", digests.foreign],
      ["other launch", digests.otherLaunch],
      ["uncheckpointed", digests.uncheckpointed],
    ] as const) {
      await send(label, outcomeReport({ kind: "buy", launchId, txDigest }));
    }
    await send("extra field", outcomeReport({ ...bidderBuy, quote: "1" }));
    node.state.reads = "down";
    await send("node down", outcomeReport(bidderBuy));
    const invalidRequest = { code: "REQUEST_INVALID", message: "The request could not be completed." };
    const serviceUnavailable = { code: "SERVICE_UNAVAILABLE", message: "This service is temporarily unavailable. Please retry." };
    assert.deepEqual(statuses, [
      ["commit launch", 201, { result: "recorded" }],
      ["commit launch again", 200, { result: "duplicate" }],
      ["commit buy", 201, { result: "recorded" }],
      ["commit buy, another visitor", 201, { result: "recorded" }],
      ["commit without a visitor", 422, { error: invalidRequest, reason: "no-visitor" }],
      ["launch by another visitor", 201, { result: "recorded" }],
      ["launch again", 200, { result: "duplicate" }],
      ["buy, no cookie", 201, { result: "recorded" }],
      ["buy, buyer's Privy session", 200, { result: "duplicate" }],
      ["buy, creator's Privy session", 200, { result: "duplicate" }],
      ["bidder buy, other wallet's session", 201, { result: "recorded" }],
      ["bidder buy, Privy down", 200, { result: "duplicate" }],
      ["settlement", 422, { error: invalidRequest, reason: "settlement-buy" }],
      ["sold", 422, { error: invalidRequest, reason: "not-a-buy" }],
      ["failed", 422, { error: invalidRequest, reason: "failed" }],
      ["unknown", 422, { error: invalidRequest, reason: "unknown-transaction" }],
      ["foreign", 422, { error: invalidRequest, reason: "foreign-lineage" }],
      ["other launch", 422, { error: invalidRequest, reason: "other-launch" }],
      ["uncheckpointed", 422, { error: invalidRequest, reason: "not-checkpointed" }],
      ["extra field", 400, { error: invalidRequest, reason: "shape" }],
      ["node down", 503, { error: serviceUnavailable, reason: "node-unavailable" }],
    ]);
    const rows = await admin.query(
      `SELECT kind, launch_id, sender_wallet, visitor_id::text, visitor_link, tx_digest, event_seq, checkpoint::int, completed_at
       FROM mission_control_launchpad_outcomes ORDER BY kind DESC, event_seq`,
    );
    const chain = { launch_id: launchId, checkpoint: OUTCOME_FIXTURE.checkpoint, completed_at: new Date(OUTCOME_FIXTURE.timestampMs) };
    assert.deepEqual(rows.rows, [
      { kind: "launch", ...chain, sender_wallet: senders.creator, visitor_id: VISITOR_ONE, visitor_link: "signed_commitment", tx_digest: digests.launch, event_seq: 1 },
      { kind: "buy", ...chain, sender_wallet: senders.buyer, visitor_id: VISITOR_THREE, visitor_link: "privy_session", tx_digest: digests.buy, event_seq: 0 },
      { kind: "buy", ...chain, sender_wallet: senders.buyer, visitor_id: null, visitor_link: null, tx_digest: digests.settlementThenBuy, event_seq: 2 },
    ].map(({ launch_id, sender_wallet, visitor_id, visitor_link, tx_digest, event_seq, checkpoint, completed_at, kind }) =>
      ({ kind, launch_id, sender_wallet, visitor_id, visitor_link, tx_digest, event_seq, checkpoint, completed_at })));
    // Every commitment went with its digest's decision.
    const left = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM mission_control_launchpad_outcome_commitments");
    assert.equal(left.rows[0]?.n, 0);

    // Storage offline: a bounded 503, nothing recorded, nothing blocked.
    const unavailable = createRuntimePool("postgres://blast_web@127.0.0.1:1/unavailable", { ...PRODUCTION_LIKE, connectionTimeoutMs: 500 });
    try {
      node.state.reads = "available";
      const offline = createLaunchpadOutcomeRouteHandler({
        expectedOrigin: ORIGIN,
        verify: createOutcomeVerifier(async () => ({ client: node.client, manifest: NON_PRODUCTION_MANIFEST })),
        emitter: createLaunchpadTelemetryEmitter(() => service(unavailable)),
      });
      const started = performance.now();
      const outage = await offline(outcomeReport({ kind: "buy", launchId, txDigest: digests.settlementThenBuy }), testClient());
      assert.equal(outage.status, 503);
      assert.deepEqual(await outage.json(), { error: serviceUnavailable, reason: "limiter-unavailable" });
      assert.ok(performance.now() - started < LAUNCHPAD_TELEMETRY_TIMEOUT_MS + 500);
    } finally {
      await unavailable.end();
    }
    const count = await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM mission_control_launchpad_outcomes");
    assert.equal(count.rows[0]?.n, 3);
  });
});

function withToken(request: Request, token: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return new Request(request, { headers });
}

test("a burst of outcome reports beyond the launchpad_outcome bucket reads no node and records nothing more", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    const now = new Date("2026-09-30T12:00:30.000Z");
    const node = createOutcomeFixtureNode();
    const handler = createLaunchpadOutcomeRouteHandler({
      expectedOrigin: ORIGIN,
      verify: createOutcomeVerifier(async () => ({ client: node.client, manifest: NON_PRODUCTION_MANIFEST })),
      emitter: createLaunchpadTelemetryEmitter(() => service(web, () => now)),
    });
    const statuses: Record<number, number> = {};
    for (let request = 0; request < 40; request += 1) {
      const response = await handler(outcomeReport({ kind: "buy", launchId: OUTCOME_FIXTURE.launchId, txDigest: OUTCOME_FIXTURE.digests.buy }), testClient());
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    }
    assert.deepEqual(statuses, { 201: 1, 200: 29, 429: 10 });
    assert.equal(node.reads(), 30, "a limited report reads no node");
    const windows = await admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM mission_control_rate_limit_windows WHERE policy_name = 'launchpad_telemetry'",
    );
    assert.equal(windows.rows[0]?.n, 0, "outcome reports never spend the coin-view bucket");
    // Another client still reports.
    const other = await handler(
      outcomeReport({ kind: "launch", launchId: OUTCOME_FIXTURE.launchId, txDigest: OUTCOME_FIXTURE.digests.launch }), testClient("198.51.100.2"),
    );
    assert.equal(other.status, 201);
  });
});

/** Captures `launchpad.telemetry` metrics for one test (the suite turns metrics off). */
function captureMetrics(t: TestContext): string[] {
  const lines: string[] = [];
  const previous = process.env.MISSION_CONTROL_METRICS;
  process.env.MISSION_CONTROL_METRICS = "on";
  t.after(() => {
    process.env.MISSION_CONTROL_METRICS = previous;
  });
  t.mock.method(console, "info", (line: string) => lines.push(line));
  return lines;
}

type StoredOutcome = { tx_digest: string; sender_wallet: string; visitor_id: string | null; visitor_link: string | null };

async function storedOutcomes(admin: Pool): Promise<StoredOutcome[]> {
  const rows = await admin.query<StoredOutcome>(
    `SELECT tx_digest, sender_wallet, visitor_id::text, visitor_link
     FROM mission_control_launchpad_outcomes ORDER BY tx_digest`,
  );
  return rows.rows;
}

async function commitmentCount(admin: Pool, txDigest?: string): Promise<number> {
  const rows = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM mission_control_launchpad_outcome_commitments
     WHERE $1::text IS NULL OR tx_digest = $1`,
    [txDigest ?? null],
  );
  return rows.rows[0]?.n ?? -1;
}

test("an outcome is its event sender's; a visitor is linked only by one commitment received before the checkpoint", { skip }, async (t) => {
  const lines = captureMetrics(t);
  await withDatabase(async ({ admin, web }) => {
    const checkpointAt = "2026-09-30T12:00:00.000Z";
    let now = new Date("2026-09-30T11:59:59.000Z");
    const telemetry = new LaunchpadTelemetryService(web, { clock: () => now });
    const commit = (visitor: string, txDigest: string) =>
      telemetry.recordOutcomeCommitment(visitor, { kind: "buy", launchId: COIN_A, txDigest });
    const record = (txDigest: string, extra: Record<string, unknown> = { visitorId: null }) =>
      telemetry.recordOutcome({ kind: "buy", launchId: COIN_A, senderWallet: SENDER, ...extra, completion: completed(txDigest, checkpointAt) });

    // One visitor committed the digest before its checkpoint: that visitor is linked.
    assert.equal(await commit(VISITOR_ONE, DIGEST_ONE), "recorded");
    assert.equal(await commit(VISITOR_ONE, DIGEST_ONE), "duplicate", "a commitment is stored once");
    // Two visitors committed another digest before its checkpoint: contested, no link.
    await commit(VISITOR_ONE, DIGEST_TWO);
    await commit(VISITOR_TWO, DIGEST_TWO);
    // A third digest is committed only at the checkpoint's own time and after it: late, no link.
    now = new Date(checkpointAt);
    await commit(VISITOR_ONE, DIGEST_THREE);
    now = new Date("2026-09-30T12:00:00.500Z");
    await commit(VISITOR_TWO, DIGEST_THREE);
    assert.equal(await commitmentCount(admin), 5);

    assert.equal(await record(DIGEST_ONE), "recorded");
    assert.equal(await record(DIGEST_TWO), "recorded");
    assert.equal(await record(DIGEST_THREE), "recorded");
    assert.deepEqual(await storedOutcomes(admin), [
      { tx_digest: DIGEST_ONE, sender_wallet: SENDER, visitor_id: VISITOR_ONE, visitor_link: "signed_commitment" },
      { tx_digest: DIGEST_TWO, sender_wallet: SENDER, visitor_id: null, visitor_link: null },
      { tx_digest: DIGEST_THREE, sender_wallet: SENDER, visitor_id: null, visitor_link: null },
    ].sort((a, b) => a.tx_digest.localeCompare(b.tx_digest)));
    // Each digest's commitments went with the decision, linked or not.
    assert.equal(await commitmentCount(admin), 0);
    // The two late commitments are visible as a bounded metric, and nothing private is logged.
    const late = lines.filter((line) => line.includes('"event":"outcome_commitment"') && line.includes('"result":"late"'));
    assert.equal(late.length, 2);
    for (const line of lines) {
      for (const value of [VISITOR_ONE, VISITOR_TWO, SENDER, DIGEST_ONE, DIGEST_TWO, DIGEST_THREE, COIN_A]) {
        assert.ok(!line.includes(value), line);
      }
    }

    // A commitment that arrives after its outcome was decided links nothing later.
    now = new Date("2026-09-30T12:00:05.000Z");
    await commit(VISITOR_THREE, DIGEST_TWO);
    assert.equal(await record(DIGEST_TWO), "duplicate");
    assert.equal((await storedOutcomes(admin)).find((row) => row.tx_digest === DIGEST_TWO)?.visitor_id, null);
  });
});

test("a link is written only onto an outcome without one, and a duplicate never changes its sender or chain facts", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    const now = new Date("2026-09-30T11:00:00.000Z");
    const telemetry = new LaunchpadTelemetryService(web, { clock: () => now });
    const outcome = { kind: "launch", launchId: COIN_A, senderWallet: SENDER, completion: completed(DIGEST_ONE, "2026-09-30T12:00:00.000Z") };

    // Recorded wallet-only first (no commitment, no Privy session).
    assert.equal(await telemetry.recordOutcome({ ...outcome, visitorId: null }), "recorded");
    // A later report from the sender's verified Privy session links that visitor.
    assert.equal(await telemetry.recordOutcome({ ...outcome, visitorId: VISITOR_ONE, visitorLink: "privy_session" }), "duplicate");
    // Neither another Privy-linked report nor an on-time commitment replaces it.
    assert.equal(await telemetry.recordOutcome({ ...outcome, visitorId: VISITOR_TWO, visitorLink: "privy_session" }), "duplicate");
    await telemetry.recordOutcomeCommitment(VISITOR_THREE, { kind: "launch", launchId: COIN_A, txDigest: DIGEST_ONE });
    assert.equal(await telemetry.recordOutcome({ ...outcome, visitorId: null }), "duplicate");
    // A competing record with other facts for the same event changes nothing.
    assert.equal(
      await telemetry.recordOutcome({
        ...outcome,
        senderWallet: `0x${"d0".repeat(32)}`,
        visitorId: null,
        completion: { ...outcome.completion, checkpoint: 1, completedAt: "2026-01-01T00:00:00.000Z" },
      }),
      "duplicate",
    );
    const rows = await admin.query(
      `SELECT sender_wallet, visitor_id::text, visitor_link, checkpoint::int, event_seq, completed_at
       FROM mission_control_launchpad_outcomes`,
    );
    assert.deepEqual(rows.rows, [{
      sender_wallet: SENDER,
      visitor_id: VISITOR_ONE,
      visitor_link: "privy_session",
      checkpoint: 326_274_009,
      event_seq: 0,
      completed_at: new Date("2026-09-30T12:00:00.000Z"),
    }]);
    assert.equal(await commitmentCount(admin), 0, "the late commitment went with the decision");

    // A Privy link wins over commitments when both exist, and the commitments still go.
    await telemetry.recordOutcomeCommitment(VISITOR_THREE, { kind: "launch", launchId: COIN_A, txDigest: DIGEST_TWO });
    await telemetry.recordOutcome({ ...outcome, completion: completed(DIGEST_TWO, "2026-09-30T12:00:00.000Z"), visitorId: VISITOR_TWO, visitorLink: "privy_session" });
    assert.deepEqual((await storedOutcomes(admin)).find((row) => row.tx_digest === DIGEST_TWO), {
      tx_digest: DIGEST_TWO, sender_wallet: SENDER, visitor_id: VISITOR_TWO, visitor_link: "privy_session",
    });
    assert.equal(await commitmentCount(admin), 0);

    // Funnel conversions still count only linked rows (unchanged semantics).
    await telemetry.recordOutcome({ ...outcome, completion: completed(DIGEST_THREE, "2026-09-30T12:00:00.000Z"), visitorId: null });
    const [period] = await telemetry.funnel({ from: "2026-09-30", to: "2026-09-30" });
    assert.deepEqual(period?.outcomes.launch, { completed: 3, convertedViewers: 0 });
  });
});

test("0037 adds the sender wallet, the visitor link and the commitments table, and rolls back and re-applies", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  async function down(name: string) {
    const sql = await readFile(new URL(`${name}.down.sql`, MIGRATIONS), "utf8");
    await admin.query(sql);
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = $1", [name]);
  }
  async function columns(): Promise<string[]> {
    const rows = await admin.query<{ column_name: string }>(
      `SELECT column_name::text FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'mission_control_launchpad_outcomes'
         AND column_name IN ('sender_wallet', 'visitor_link') ORDER BY 1`,
    );
    return rows.rows.map((row) => row.column_name);
  }
  async function commitmentsTable(): Promise<boolean> {
    const rows = await admin.query("SELECT to_regclass('public.mission_control_launchpad_outcome_commitments') IS NOT NULL AS present");
    return rows.rows[0]?.present === true;
  }
  const legacy = digest("L");
  try {
    await migrateDatabase(admin);
    await admin.query("DELETE FROM mission_control_launchpad_outcomes WHERE tx_digest = $1", [legacy]);
    assert.deepEqual(await columns(), ["sender_wallet", "visitor_link"]);
    assert.equal(await commitmentsTable(), true);

    await down("0037_launchpad_outcome_attribution");
    assert.deepEqual(await columns(), []);
    assert.equal(await commitmentsTable(), false);
    // Development rows recorded before 0037: one with a visitor, one without; neither has a sender or a link.
    await admin.query(
      `INSERT INTO mission_control_launchpad_outcomes (tx_digest, event_seq, kind, checkpoint, launch_id, visitor_id, completed_at)
       VALUES ($1, 0, 'buy', 1, $2, $3, now()), ($1, 2, 'buy', 1, $2, NULL, '2026-09-30T12:00:00Z')`,
      [legacy, COIN_A, VISITOR_ONE],
    );
    assert.deepEqual(await migrateDatabase(admin), ["0037_launchpad_outcome_attribution"]);
    assert.deepEqual(await columns(), ["sender_wallet", "visitor_link"]);
    assert.deepEqual(await migrateDatabase(admin), [], "re-runnable");

    // A linked report of the unlinked legacy event is a duplicate that leaves the legacy row as it was.
    const legacyReport = {
      kind: "buy",
      launchId: COIN_A,
      senderWallet: SENDER,
      visitorId: VISITOR_TWO,
      visitorLink: "privy_session",
      completion: { status: "completed", checkpoint: 1, txDigest: legacy, eventSeq: 2, completedAt: "2026-09-30T12:00:00.000Z" },
    };
    assert.equal(await new LaunchpadTelemetryService(admin).recordOutcome(legacyReport), "duplicate");
    // The legacy rows are untouched; every new row needs a canonical sender, and a link exactly with a visitor.
    const kept = await admin.query(
      "SELECT event_seq, sender_wallet, visitor_id::text, visitor_link FROM mission_control_launchpad_outcomes WHERE tx_digest = $1 ORDER BY event_seq",
      [legacy],
    );
    assert.deepEqual(kept.rows, [
      { event_seq: 0, sender_wallet: null, visitor_id: VISITOR_ONE, visitor_link: null },
      { event_seq: 2, sender_wallet: null, visitor_id: null, visitor_link: null },
    ]);
    const insert = (values: Record<string, unknown>) =>
      admin.query(
        `INSERT INTO mission_control_launchpad_outcomes
           (tx_digest, event_seq, kind, checkpoint, launch_id, sender_wallet, visitor_id, visitor_link, completed_at)
         VALUES ($1, 1, 'buy', 1, $2, $3, $4, $5, now())`,
        [legacy, COIN_A, values.sender ?? null, values.visitor ?? null, values.link ?? null],
      ).then(() => "ok", (error: { code?: string }) => error.code);
    assert.equal(await insert({}), "23514", "no sender");
    assert.equal(await insert({ sender: SENDER.toUpperCase() }), "23514", "a non-canonical sender");
    assert.equal(await insert({ sender: SENDER, visitor: VISITOR_ONE }), "23514", "a visitor without a link");
    assert.equal(await insert({ sender: SENDER, link: "privy_session" }), "23514", "a link without a visitor");
    assert.equal(await insert({ sender: SENDER, visitor: VISITOR_ONE, link: "cookie" }), "23514", "an unknown link");
    assert.equal(await insert({ sender: SENDER, visitor: VISITOR_ONE, link: "signed_commitment" }), "ok");
    const commitment = (values: unknown[]) =>
      admin.query(
        `INSERT INTO mission_control_launchpad_outcome_commitments (tx_digest, visitor_id, kind, launch_id, committed_at)
         VALUES ($1, $2, $3, $4, now())`,
        values,
      ).then(() => "ok", (error: { code?: string }) => error.code);
    assert.equal(await commitment([legacy, VISITOR_ONE, "migration", COIN_A]), "23514", "only launch and buy are committed");
    assert.equal(await commitment([legacy, VISITOR_ONE, "buy", SENDER.slice(0, 20)]), "23514");
    assert.equal(await commitment([`0x${"ab".repeat(32)}`, VISITOR_ONE, "buy", COIN_A]), "23514", "a digest is Base58");
    assert.equal(await commitment([legacy, VISITOR_ONE, "buy", COIN_A]), "ok");
    assert.equal(await commitment([legacy, VISITOR_ONE, "launch", COIN_A]), "23505", "one commitment per digest and visitor");

    // The per-wallet index, and the commitments table is the web runtime's alone.
    const index = await admin.query(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'mission_control_launchpad_outcomes_sender_idx'",
    );
    assert.match(String(index.rows[0]?.indexdef), /\(sender_wallet, kind, completed_at\)/);
    const grants = await admin.query<{ grantee: string; privileges: string }>(
      `SELECT grantee::text, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
       FROM information_schema.role_table_grants
       WHERE table_name = 'mission_control_launchpad_outcome_commitments' AND grantee LIKE 'blast\\_%'
       GROUP BY grantee`,
    );
    assert.deepEqual(grants.rows, [{ grantee: "blast_web", privileges: "DELETE,INSERT,SELECT" }]);
  } finally {
    await admin.query("DELETE FROM mission_control_launchpad_outcome_commitments WHERE tx_digest = $1", [legacy]).catch(() => undefined);
    await admin.query("DELETE FROM mission_control_launchpad_outcomes WHERE tx_digest = $1", [legacy]).catch(() => undefined);
    await admin.end();
  }
});

test("the maintenance cleanup deletes commitments never decided after the configured window", { skip }, async () => {
  await withDatabase(async ({ admin, web }) => {
    const now = new Date("2026-09-30T12:00:00.000Z");
    // The route passes the request's arrival as the receipt time; the service clock is only a fallback.
    const telemetry = new LaunchpadTelemetryService(web, { clock: () => now });
    for (const [visitor, minutesAgo] of [[VISITOR_ONE, 61], [VISITOR_TWO, 59]] as const) {
      const receivedAt = new Date(now.getTime() - minutesAgo * 60_000);
      await telemetry.recordOutcomeCommitment(visitor, { kind: "buy", launchId: COIN_A, txDigest: DIGEST_ONE }, receivedAt);
    }
    const stored = await admin.query<{ committed_at: Date }>(
      "SELECT committed_at FROM mission_control_launchpad_outcome_commitments ORDER BY committed_at",
    );
    assert.deepEqual(stored.rows.map((row) => row.committed_at.toISOString()), ["2026-09-30T10:59:00.000Z", "2026-09-30T11:01:00.000Z"]);
    const report = await runCleanup(admin, { clock: () => now });
    assert.equal(report.tables.mission_control_launchpad_outcome_commitments.deleted, 1);
    const left = await admin.query<{ visitor_id: string }>("SELECT visitor_id::text FROM mission_control_launchpad_outcome_commitments");
    assert.deepEqual(left.rows, [{ visitor_id: VISITOR_TWO }]);
  });
});

test("a creation with the creator's first buy links both its outcomes by the one commitment decision, in either report order", { skip }, async () => {
  const { launchId, digests, senders } = OUTCOME_FIXTURE;
  const txDigest = digests.creationWithBuy;
  type Report = Readonly<{ kind: "launch" | "buy"; visitor: string | null; token?: string }>;
  async function scenario(committers: readonly string[], reports: readonly Report[], afterFirst?: (admin: Pool) => Promise<void>) {
    let rows: Array<{ kind: string; event_seq: number; sender_wallet: string; visitor_id: string | null; visitor_link: string | null }> = [];
    let left = -1;
    await withDatabase(async ({ admin, web }) => {
      const node = createOutcomeFixtureNode();
      // Commitments arrive two seconds before the fixture checkpoint; reports after it.
      const emitter = createLaunchpadTelemetryEmitter(() => service(web, () => new Date(OUTCOME_FIXTURE.timestampMs - 2_000)));
      const handler = createLaunchpadOutcomeRouteHandler({
        expectedOrigin: ORIGIN,
        verify: createOutcomeVerifier(async () => ({ client: node.client, manifest: NON_PRODUCTION_MANIFEST })),
        emitter,
        // A fixture Privy: "token-creator" is a session whose embedded wallet is the creation's sender.
        verifyPrivySession: async (token) => {
          if (token !== "token-creator") throw Object.assign(new Error("invalid"), { code: "INVALID_ACCESS_TOKEN" });
          return { suiWalletAddress: senders.creator };
        },
      });
      const commitments = createLaunchpadOutcomeCommitmentRouteHandler({
        expectedOrigin: ORIGIN,
        emitter,
        // Commitments arrive two seconds before the fixture checkpoint.
        clock: () => new Date(OUTCOME_FIXTURE.timestampMs - 2_000),
      });
      for (const visitor of committers) {
        const request = outcomeReport({ kind: "launch", launchId, txDigest }, `${VISITOR_COOKIE_NAME}=${visitor}`);
        const response = await commitments(
          new Request(`${ORIGIN}/api/launchpad/outcomes/commitments`, { method: "POST", headers: request.headers, body: JSON.stringify({ kind: "launch", launchId, txDigest }) }), testClient(),
        );
        assert.equal(response.status, 201);
      }
      for (const [index, { kind, visitor, token }] of reports.entries()) {
        const request = outcomeReport({ kind, launchId, txDigest }, visitor && `${VISITOR_COOKIE_NAME}=${visitor}`);
        const response = await handler(token ? withToken(request, token) : request, testClient());
        assert.equal(response.status, 201, `${kind} by ${visitor ?? "a cookieless reporter"}`);
        if (index === 0) await afterFirst?.(admin);
      }
      rows = (await admin.query(
        `SELECT kind, event_seq, sender_wallet, visitor_id::text, visitor_link
         FROM mission_control_launchpad_outcomes WHERE tx_digest = $1 ORDER BY event_seq`,
        [txDigest],
      )).rows;
      left = (await admin.query<{ n: number }>("SELECT count(*)::int AS n FROM mission_control_launchpad_outcome_commitments")).rows[0]?.n ?? -1;
    });
    return { rows, left };
  }
  const linked = (visitor: string | null, link = "signed_commitment") => [
    { kind: "buy", event_seq: 0, sender_wallet: senders.creator, visitor_id: visitor, visitor_link: visitor && link },
    { kind: "launch", event_seq: 1, sender_wallet: senders.creator, visitor_id: visitor, visitor_link: visitor && link },
  ];

  // D1, the engine's order: the creator's browser reports the launch, then the same browser reports the buy.
  const d1 = await scenario([VISITOR_ONE], [{ kind: "launch", visitor: VISITOR_ONE }, { kind: "buy", visitor: VISITOR_ONE }]);
  assert.deepEqual(d1, { rows: linked(VISITOR_ONE), left: 0 }, "D1");
  // D2: a cookieless third party reports the buy first, then the creator's engine reports the launch.
  const d2 = await scenario([VISITOR_ONE], [{ kind: "buy", visitor: null }, { kind: "launch", visitor: VISITOR_ONE }]);
  assert.deepEqual(d2, { rows: linked(VISITOR_ONE), left: 0 }, "D2");
  // Another visitor's commitment received after the decision (after the checkpoint) does not undo it for the sibling.
  const intruder = await scenario(
    [VISITOR_ONE],
    [{ kind: "launch", visitor: VISITOR_ONE }, { kind: "buy", visitor: VISITOR_TWO }],
    (admin) =>
      admin.query(
        `INSERT INTO mission_control_launchpad_outcome_commitments (tx_digest, visitor_id, kind, launch_id, committed_at)
         VALUES ($1, $2, 'buy', $3, $4)`,
        [txDigest, VISITOR_TWO, launchId, new Date(OUTCOME_FIXTURE.timestampMs + 5_000)],
      ).then(() => undefined),
  );
  assert.deepEqual(intruder, { rows: linked(VISITOR_ONE), left: 0 }, "late intruder");
  // A contested decision is the digest's too: neither outcome is linked, in either order.
  const contested = await scenario([VISITOR_ONE, VISITOR_TWO], [{ kind: "buy", visitor: null }, { kind: "launch", visitor: VISITOR_ONE }]);
  assert.deepEqual(contested, { rows: linked(null), left: 0 }, "contested");

  // A Privy creator, the engine's order: the launch is reported with the creator's session (and V1 committed), then a
  // cookieless client reports the buy. The buy reuses the launch's recorded link: same visitor, same kind.
  const privyFirst = await scenario([VISITOR_ONE], [
    { kind: "launch", visitor: VISITOR_ONE, token: "token-creator" },
    { kind: "buy", visitor: null },
  ]);
  assert.deepEqual(privyFirst, { rows: linked(VISITOR_ONE, "privy_session"), left: 0 }, "Privy first");
  // The reverse order: the cookieless buy is decided first by V1's commitment; the launch, reported with the
  // session, reuses that recorded link rather than deciding again.
  const privyLast = await scenario([VISITOR_ONE], [
    { kind: "buy", visitor: null },
    { kind: "launch", visitor: VISITOR_ONE, token: "token-creator" },
  ]);
  assert.deepEqual(privyLast, { rows: linked(VISITOR_ONE, "signed_commitment"), left: 0 }, "Privy last");
  // The documented edge: the session holder (V2) and the on-time committer (V1) differ. The link follows whichever
  // outcome is decided first, and both siblings carry it.
  const holderFirst = await scenario([VISITOR_ONE], [
    { kind: "launch", visitor: VISITOR_TWO, token: "token-creator" },
    { kind: "buy", visitor: null },
  ]);
  assert.deepEqual(holderFirst, { rows: linked(VISITOR_TWO, "privy_session"), left: 0 }, "session holder first");
  const committerFirst = await scenario([VISITOR_ONE], [
    { kind: "buy", visitor: null },
    { kind: "launch", visitor: VISITOR_TWO, token: "token-creator" },
  ]);
  assert.deepEqual(committerFirst, { rows: linked(VISITOR_ONE, "signed_commitment"), left: 0 }, "committer first");
});

test("concurrent reports of a Privy creator's launch and its first buy end with one link on both siblings", { skip }, async () => {
  const { launchId, digests, senders } = OUTCOME_FIXTURE;
  const txDigest = digests.creationWithBuy;
  const completion = (eventSeq: number) => ({
    status: "completed" as const,
    checkpoint: OUTCOME_FIXTURE.checkpoint,
    txDigest,
    eventSeq,
    completedAt: new Date(OUTCOME_FIXTURE.timestampMs).toISOString(),
  });
  const launch = { kind: "launch" as const, launchId, senderWallet: senders.creator, visitorId: VISITOR_ONE, visitorLink: "privy_session" as const, completion: completion(1) };
  const buy = { kind: "buy" as const, launchId, senderWallet: senders.creator, visitorId: null, completion: completion(0) };
  await withDatabase(async ({ admin, web }) => {
    const repository = new LaunchpadTelemetryRepository();
    const telemetry = new LaunchpadTelemetryService(web, { clock: () => new Date(OUTCOME_FIXTURE.timestampMs - 2_000) });
    const seen = new Map<string, number>();
    for (let run = 0; run < 30; run += 1) {
      await admin.query("DELETE FROM mission_control_launchpad_outcomes WHERE tx_digest = $1", [txDigest]);
      await telemetry.recordOutcomeCommitment(VISITOR_ONE, { kind: "launch", launchId, txDigest });
      // Both reports in flight at once, started in alternating order, on separate connections.
      const reports = run % 2 === 0 ? [launch, buy] : [buy, launch];
      await Promise.all(reports.map((outcome) => repository.recordOutcome(web, outcome)));
      const rows = (await admin.query<{ kind: string; visitor_id: string | null; visitor_link: string | null }>(
        "SELECT kind, visitor_id::text, visitor_link FROM mission_control_launchpad_outcomes WHERE tx_digest = $1 ORDER BY event_seq",
        [txDigest],
      )).rows;
      assert.equal(rows.length, 2, `run ${run}`);
      assert.deepEqual([rows[0]!.visitor_id, rows[0]!.visitor_link], [rows[1]!.visitor_id, rows[1]!.visitor_link], `run ${run}: siblings differ`);
      assert.equal(rows[0]!.visitor_id, VISITOR_ONE, `run ${run}`);
      const key = String(rows[0]!.visitor_link);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    // Whichever report is decided first sets the kind; both kinds occur across runs only if the race goes both ways.
    assert.ok([...seen.keys()].every((kind) => kind === "privy_session" || kind === "signed_commitment"), JSON.stringify([...seen]));
  }, { ...PRODUCTION_LIKE, max: 6, connectionTimeoutMs: 2_000 });
});
