import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { Pool } from "pg";
// eslint-disable-next-line no-restricted-imports -- Proof-only HTTP consumer composition; worker runtime never imports the dashboard.
import { createAccountSummaryReader } from "../../../../web/analytics/src/account-summary.ts";
import { publishAccountSnapshot, readAccountReport } from "./account-report.ts";
import { createAnalyticsHandler } from "./api.ts";
import { analyticsPool, readAccountReportingConfig } from "./config.ts";
import { aggregateSnapshot } from "./contract.ts";
import { publishAvailableSnapshots } from "./refresh.ts";
import { readSnapshot, readSnapshotV3 } from "./snapshot-reader.ts";
import { importBatch, initializeWarehouse, publishSnapshot } from "./store.ts";

const base = new URL(
  process.env.MISSION_CONTROL_TEST_DATABASE_URL ?? "https://missing.invalid",
);
assert.equal(
  base.hostname,
  "127.0.0.1",
  "Disposable loopback PostgreSQL is required",
);
const owner = `report_owner_${process.pid}`;
const database = `account_reporting_${process.pid}`;
const url = new URL(base);
url.pathname = `/${database}`;
const maintenanceUrl = new URL(base);
maintenanceUrl.pathname = "/postgres";
const maintenance = new Pool({
  connectionString: maintenanceUrl.toString(),
  max: 1,
});
const operatorUrl = new URL(url);
operatorUrl.username = owner;
operatorUrl.password = "disposable-test";
const operator = new Pool({ connectionString: operatorUrl.toString(), max: 1 });
const runtime = (suffix: string) => {
  const value = new URL(url);
  value.username = `report_${suffix}_${process.pid}`;
  value.password = "disposable-test";
  return analyticsPool(value.toString(), `account-report-${suffix}`);
};
const writer = runtime("writer");
const reader = runtime("reader");
const ingress = runtime("ingress");
const outsider = runtime("outsider");
const scope = "a".repeat(64);
const hash = (digit: string) => digit.repeat(64);
const t = new Date("2026-11-16T12:00:00.000Z");
const upgrade = await readFile(
  new URL("./migrations/0002_account_reporting.sql", import.meta.url),
  "utf8",
);
let originalV2: unknown;

before(async () => {
  await maintenance.query(
    `CREATE ROLE ${owner} LOGIN PASSWORD 'disposable-test' CREATEDB CREATEROLE`,
  );
  const bootstrap = new Pool({
    connectionString: new URL(
      operatorUrl.toString().replace(`/${database}`, "/postgres"),
    ).toString(),
    max: 1,
  });
  try {
    await bootstrap.query(`CREATE DATABASE ${database}`);
  } finally {
    await bootstrap.end();
  }
  await operator.query(
    await readFile(new URL("./warehouse.sql", import.meta.url), "utf8"),
  );
  await operator.query(
    await readFile(
      new URL("./migrations/0001_account_activity.sql", import.meta.url),
      "utf8",
    ),
  );
  await maintenance.query(`
    CREATE ROLE report_writer_${process.pid} LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_writer TO report_writer_${process.pid};
    CREATE ROLE report_reader_${process.pid} LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_reader TO report_reader_${process.pid};
    CREATE ROLE report_ingress_${process.pid} LOGIN PASSWORD 'disposable-test'; GRANT blast_analytics_ingress TO report_ingress_${process.pid};
    CREATE ROLE report_outsider_${process.pid} LOGIN PASSWORD 'disposable-test';`);
  const client = await writer.connect();
  try {
    await initializeWarehouse(client, "c".repeat(64), "0");
    await importBatch(
      client,
      {
        checkpoint: "1",
        digest: "committed-cut",
        timestampMs: "1577836800000",
        facts: [
          {
            fact_id: "exact-trade",
            checkpoint: "1",
            timestamp_ms: "1577836800000",
            digest: "tx",
            actor: null,
            kind: "trade",
            coin_type: "COIN",
            usd_value: "9007199254740993.123456789012345678",
          },
        ],
      },
      "test-wallet-key-01234567890123456789",
    );
    await publishSnapshot(client, "1");
    originalV2 = await readSnapshot(reader);
  } finally {
    client.release();
  }
  await ingress.query("SELECT blast_analytics.record_activity($1,$2)", [
    hash("1"),
    scope,
  ]);
});

after(async () => {
  await Promise.all([
    writer.end(),
    reader.end(),
    ingress.end(),
    outsider.end(),
    operator.end(),
  ]);
  // Pool shutdown can resolve while its sockets are still closing. Let PostgreSQL wait for disconnects.
  await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
  await maintenance.query(
    `DROP ROLE report_writer_${process.pid},report_reader_${process.pid},report_ingress_${process.pid},report_outsider_${process.pid}`,
  );
  await maintenance.query(`DROP ROLE ${owner}`);
  await maintenance.end();
});

// Fails if an upgrade loses v2/ingress data, accepts the wrong ledger, or broadens runtime privileges.
test("non-superuser forward upgrade preserves old data and isolates reporting permissions", async () => {
  const dormant = await writer.connect();
  try {
    await publishAvailableSnapshots(dormant, null);
  } finally {
    dormant.release();
  }
  await assert.rejects(readSnapshotV3(reader), { code: "42P01" });
  const token = "unupgraded-report-token-0123456789012345";
  const disabledApi = createServer(
    createAnalyticsHandler(token, () => readSnapshot(reader)),
  );
  disabledApi.listen(0, "127.0.0.1");
  await once(disabledApi, "listening");
  const address = disabledApi.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v3/summary`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    assert.equal(response.status, 404);
  } finally {
    disabledApi.closeAllConnections();
    await new Promise<void>((resolve) => disabledApi.close(() => resolve()));
  }
  assert.equal(
    (
      await operator.query(
        "SELECT rolsuper FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0].rolsuper,
    false,
  );
  const before = (
    await operator.query("SELECT to_jsonb(a) FROM blast_analytics.accounts a")
  ).rows;
  await operator.query(upgrade);
  assert.deepEqual(
    (await operator.query("SELECT to_jsonb(a) FROM blast_analytics.accounts a"))
      .rows,
    before,
  );
  assert.deepEqual(await readSnapshot(reader), originalV2);
  assert.deepEqual(
    (
      await operator.query(
        "SELECT version,name FROM blast_analytics.schema_migrations ORDER BY version",
      )
    ).rows,
    [
      { version: 0, name: "warehouse-v1" },
      { version: 1, name: "account-activity-v1" },
      { version: 2, name: "account-reporting-v3" },
    ],
  );
  await assert.rejects(operator.query(upgrade), {
    message: "unexpected analytics warehouse migration version",
  });
  await operator.query("ROLLBACK");
  assert.deepEqual(await readSnapshot(reader), originalV2);
  await assert.rejects(
    reader.query("SELECT account_hash FROM blast_analytics.accounts"),
    { code: "42501" },
  );
  await assert.rejects(
    reader.query("SELECT scope FROM blast_analytics.account_collection"),
    { code: "42501" },
  );
  await assert.rejects(
    ingress.query("SELECT * FROM blast_analytics.snapshots_v3"),
    { code: "42501" },
  );
  await assert.rejects(
    ingress.query("SELECT account_hash FROM blast_analytics.accounts"),
    { code: "42501" },
  );
  await assert.rejects(
    reader.query("DELETE FROM blast_analytics.snapshots_v3"),
    { code: "42501" },
  );
  await assert.rejects(
    writer.query("SELECT * FROM blast_analytics.access_codes"),
    { code: "42501" },
  );
  await assert.rejects(
    outsider.query("SELECT * FROM blast_analytics.snapshots_v3"),
    { code: "42501" },
  );
});

// Fails if the singleton's existence turns uncollected accounts into measured zero or scope drift is accepted.
test("null collection is unavailable while a measured empty interval has UTC zero days", async () => {
  await operator.query(
    "TRUNCATE blast_analytics.accounts CASCADE; UPDATE blast_analytics.account_collection SET scope=NULL,started_at=NULL",
  );
  const client = await writer.connect();
  try {
    assert.equal(await readAccountReport(client, scope, t), null);
    await operator.query(
      "UPDATE blast_analytics.account_collection SET scope=$1,started_at='2026-11-14T23:59:59Z'",
      [scope],
    );
    await client.query("SET TIME ZONE 'Pacific/Auckland'");
    assert.deepEqual(await readAccountReport(client, scope, t), {
      unit: "authenticated-existing-accounts",
      collectionStartedAt: "2026-11-14T23:59:59.000Z",
      dau24h: "0",
      mau30d: "0",
      uniqueSinceCollection: "0",
      partial30d: true,
      samplingIntervalMs: 900000,
      daily: [
        { day_ms: "1794614400000", accounts: "0" },
        { day_ms: "1794700800000", accounts: "0" },
        { day_ms: "1794787200000", accounts: "0" },
      ],
    });
    await assert.rejects(readAccountReport(client, hash("b"), t), {
      message: "Account reporting scope changed; reconciliation required",
    });
    await client.query("SET TIME ZONE 'America/New_York'");
    await operator.query(
      "UPDATE blast_analytics.account_collection SET started_at='2026-10-17T12:00:00Z'",
    );
    assert.equal(
      (await readAccountReport(client, scope, t))?.partial30d,
      false,
    );
    await operator.query(
      "UPDATE blast_analytics.account_collection SET started_at='2026-10-17T12:00:00.001Z'",
    );
    assert.equal((await readAccountReport(client, scope, t))?.partial30d, true);
    await operator.query(
      "UPDATE blast_analytics.account_collection SET started_at='2026-11-17T00:00:00Z'",
    );
    await assert.rejects(readAccountReport(client, scope, t), {
      message: "Account collection starts after observation",
    });
  } finally {
    client.release();
  }
});

// Fails if either rolling edge is closed/open incorrectly, future data is counted, or daily zeros use local time.
test("one observation cut excludes lower edges and future rows while including the upper edge", async () => {
  await operator.query("TRUNCATE blast_analytics.accounts CASCADE");
  await operator.query(
    "UPDATE blast_analytics.account_collection SET scope=$1,started_at='2026-10-07T12:00:00Z'",
    [scope],
  );
  await operator.query(
    `INSERT INTO blast_analytics.accounts VALUES
    ($1,'2026-10-07T12:00:00Z','2026-10-17T12:00:00Z'),
    ($2,'2026-10-07T12:00:00Z','2026-10-17T12:00:00.001Z'),
    ($3,'2026-10-07T12:00:00Z','2026-11-15T12:00:00Z'),
    ($4,'2026-10-07T12:00:00Z','2026-11-15T12:00:00.001Z'),
    ($5,'2026-10-07T12:00:00Z','2026-11-16T12:00:00Z'),
    ($6,'2026-10-07T12:00:00Z','2026-11-16T12:00:00.001Z'),
    ($7,'2026-11-16T12:00:00.001Z','2026-11-16T12:00:00.001Z'),
    ($8,'2026-10-07T11:59:59.999Z','2026-11-16T12:00:00Z')`,
    [
      hash("1"),
      hash("2"),
      hash("3"),
      hash("4"),
      hash("5"),
      hash("6"),
      hash("7"),
      hash("8"),
    ],
  );
  await operator.query(
    `INSERT INTO blast_analytics.account_days VALUES
    ($1,'2026-11-15'),($2,'2026-11-15'),($3,'2026-11-16'),($3,'2026-11-17'),
    ($4,'2026-11-16'),($5,'2026-11-16'),($6,'2026-11-16') ON CONFLICT DO NOTHING`,
    [hash("3"), hash("4"), hash("5"), hash("6"), hash("7"), hash("8")],
  );
  const client = await writer.connect();
  try {
    await client.query("SET TIME ZONE 'America/New_York'");
    const report = await readAccountReport(client, scope, t);
    assert.ok(report);
    assert.equal(report.dau24h, "2");
    assert.equal(report.mau30d, "4");
    assert.equal(report.uniqueSinceCollection, "6");
    assert.equal(report.partial30d, false);
    assert.equal(report.daily.length, 30);
    assert.deepEqual(report.daily[0], {
      day_ms: "1792281600000",
      accounts: "0",
    });
    assert.deepEqual(report.daily.slice(-2), [
      { day_ms: "1794700800000", accounts: "2" },
      { day_ms: "1794787200000", accounts: "1" },
    ]);
    assert.ok(report.daily.slice(0, -2).every((day) => day.accounts === "0"));
  } finally {
    client.release();
  }
});

// Fails if quiet chain progress suppresses warehouse-time publication or v3 failure damages old v2 state.
test("quiet chain publication refreshes accounts independently and leaves last good reports on faults", async () => {
  await operator.query(
    "TRUNCATE blast_analytics.accounts CASCADE; UPDATE blast_analytics.account_collection SET scope=NULL,started_at=NULL",
  );
  const client = await writer.connect();
  try {
    await publishAvailableSnapshots(client, null, { scope });
    assert.equal((await readSnapshotV3(reader))?.payload.accountActivity, null);
    await ingress.query("SELECT blast_analytics.record_activity($1,$2)", [
      hash("9"),
      scope,
    ]);
    await publishAvailableSnapshots(client, null, { scope });
    const result = await readSnapshotV3(reader);
    assert.ok(result?.payload.accountActivity);
    assert.equal(result.payload.accountActivity.dau24h, "1");
    assert.equal(result.payload.accountActivity.uniqueSinceCollection, "1");
    assert.equal(result.payload.asOfTimestampMs, "1577836800000");
    assert.equal(
      result.payload.chainPublicationTimestampMs,
      (originalV2 as { generated_at: Date }).generated_at.getTime().toString(),
    );
    assert.ok(
      BigInt(result.payload.accountObservationTimestampMs) > 1577836800000n,
    );
    await assert.rejects(publishAccountSnapshot(client, hash("b")), {
      message: "Account reporting scope changed; reconciliation required",
    });
    assert.deepEqual(await readSnapshotV3(reader), result);
    assert.deepEqual(await readSnapshot(reader), originalV2);
    await operator.query(
      "REVOKE INSERT,UPDATE ON blast_analytics.snapshots_v3 FROM blast_analytics_writer",
    );
    await assert.rejects(publishAccountSnapshot(client, scope), {
      code: "42501",
    });
    assert.deepEqual(await readSnapshotV3(reader), result);
    await operator.query(
      "GRANT INSERT,UPDATE ON blast_analytics.snapshots_v3 TO blast_analytics_writer",
    );
  } finally {
    client.release();
  }
});

// Fails if auth precedes the wrong loader, disabled mode reads v3, clocks are conflated, or the opt-in consumer drifts.
test("actual private API composes with the strict opt-in v3 consumer while v2 stays selected", async () => {
  const token = "private-report-token-01234567890123456789";
  let v3Reads = 0;
  const server = createServer(
    createAnalyticsHandler(
      token,
      () => readSnapshot(reader),
      async () => {
        v3Reads++;
        return readSnapshotV3(reader);
      },
    ),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(origin + "/v3/summary")).status, 401);
    assert.equal(v3Reads, 0);
    assert.equal(createAccountSummaryReader("invalid", "invalid"), null);
    const load = createAccountSummaryReader(origin, token, {
      enabled: true,
      development: true,
    });
    assert.ok(load);
    const value = await load();
    assert.equal(value.version, 3);
    assert.equal(value.chainStale, true);
    assert.equal(value.accountStale, false);
    assert.equal(value.accountActivity?.dau24h, "1");
    assert.equal(
      value.totals.trade_volume?.pricedUsd,
      "9007199254740993.123456789012345678",
    );
    assert.doesNotMatch(
      JSON.stringify(value),
      /account_hash|"scope"|committed-cut|disposable-test/,
    );
    await operator.query(
      `UPDATE blast_analytics.snapshots_v3 SET
      payload=jsonb_set(jsonb_set(payload,'{asOfTimestampMs}',to_jsonb($1::text)),
        '{accountObservationTimestampMs}',to_jsonb($2::text)),generated_at=clock_timestamp()`,
      [String(Date.now()), String(Date.now() - 3601000)],
    );
    const accountOld = await fetch(origin + "/v3/summary", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(accountOld.status, 200);
    const independent = await accountOld.json();
    assert.equal(independent.chainStale, false);
    assert.equal(independent.accountStale, true);
    const freshMs = String(Date.now());
    await operator.query(
      `UPDATE blast_analytics.snapshots_v3 SET payload=
      jsonb_set(jsonb_set(payload,'{chainPublicationTimestampMs}',to_jsonb($1::text)),
        '{accountObservationTimestampMs}',to_jsonb($2::text))`,
      [String(Date.now() - 3601000), freshMs],
    );
    const stalePublication = await fetch(origin + "/v3/summary", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(stalePublication.status, 200);
    const oldChain = await stalePublication.json();
    assert.equal(oldChain.chainStale, true);
    assert.equal(oldChain.accountStale, false);
    await operator.query(
      `UPDATE blast_analytics.snapshots_v3 SET payload=
      jsonb_set(payload,'{chainPublicationTimestampMs}',to_jsonb($1::text))`,
      [String(Date.now() + 60000)],
    );
    const futurePublication = await fetch(origin + "/v3/summary", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(futurePublication.status, 200);
    assert.equal((await futurePublication.json()).chainStale, true);
    const old = await fetch(origin + "/v1/summary", {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(old.status, 200);
    const { generatedAt, stale, ...payload } = await old.json();
    assert.equal(stale, true);
    assert.ok(generatedAt);
    aggregateSnapshot.parse(payload);
    assert.deepEqual(payload, (originalV2 as { payload: unknown }).payload);
    await operator.query(
      "REVOKE SELECT ON blast_analytics.snapshots_v3 FROM blast_analytics_reader",
    );
    assert.equal(
      (
        await fetch(origin + "/v3/summary", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await fetch(origin + "/v1/summary", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      200,
    );
    await operator.query(
      "GRANT SELECT ON blast_analytics.snapshots_v3 TO blast_analytics_reader",
    );
    assert.equal(readAccountReportingConfig({}), null);
    assert.throws(
      () =>
        readAccountReportingConfig({
          ANALYTICS_ACCOUNT_REPORTING_ENABLED: "true",
        }),
      /required/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
