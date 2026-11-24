// Explicitly run by analytics-collector.sh against real migrations and a physical standby.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createAnalyticsHandler } from "../src/modules/analytics/api.ts";
import { analyticsPool, readAnalyticsConfig } from "../src/modules/analytics/config.ts";
import type { Snapshot } from "../src/modules/analytics/contract.ts";
import { refreshAnalytics } from "../src/modules/analytics/refresh.ts";
import { readFactBatch, type Cursor } from "../src/modules/analytics/source.ts";
import { importBatch, publishSnapshot } from "../src/modules/analytics/store.ts";

function localUrl(key: string): string {
  const value = process.env[key];
  assert.ok(value, `Run analytics-collector.sh: ${key} is required`);
  const url = new URL(value);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.search, "");
  return value;
}

const sourceAdmin = new Pool({
  connectionString: localUrl("ANALYTICS_TEST_PRIMARY_ADMIN_URL"),
  max: 1,
  options: "-c search_path=blast_infra",
});
const replicaAdmin = new Pool({
  connectionString: localUrl("ANALYTICS_TEST_STANDBY_ADMIN_URL"),
  max: 1,
});
const warehouseAdmin = new Pool({
  connectionString: localUrl("ANALYTICS_TEST_WAREHOUSE_ADMIN_URL"),
  max: 1,
});
const warehouseReader = analyticsPool(
  localUrl("ANALYTICS_TEST_READER_URL"),
  "analytics-test-reader",
);
const config = readAnalyticsConfig({
  ANALYTICS_ENABLED: "true",
  ANALYTICS_SOURCE_DATABASE_URL: localUrl("ANALYTICS_TEST_SOURCE_URL"),
  ANALYTICS_WAREHOUSE_DATABASE_URL: localUrl("ANALYTICS_TEST_WRITER_URL"),
  ANALYTICS_NETWORK: "mainnet",
  ANALYTICS_DEPLOYMENT_FINGERPRINT: "a".repeat(64),
  ANALYTICS_FIRST_CHECKPOINT: "1",
  ANALYTICS_WALLET_HASH_KEY: "collector-disposable-wallet-key-32-chars",
})!;
const sourceReader = analyticsPool(
  config.sourceUrl,
  "analytics-test-receipt-reader",
);
const token = "collector-disposable-summary-token-32-chars";
const api = createServer(
  createAnalyticsHandler(
    token,
    async () =>
      (
        await warehouseReader.query<Snapshot>(
          "SELECT generated_at,payload FROM blast_analytics.snapshots WHERE singleton",
        )
      ).rows[0] ?? null,
  ),
);
let apiUrl: string;
let policyDefinition: string;

before(async () => {
  policyDefinition = (
    await sourceAdmin.query<{ definition: string }>(
      "SELECT pg_get_viewdef('chain_read_v1.analytics_policy'::regclass,true) AS definition",
    )
  ).rows[0]!.definition;
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  apiUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  await sourceAdmin.query(`
    CREATE OR REPLACE VIEW chain_read_v1.analytics_policy AS ${policyDefinition};
    TRUNCATE projection_faults,sale_coin_faults,archive_cuts,excluded_sale_packages,watermarks,activity;
    INSERT INTO excluded_sale_packages VALUES('0x'||repeat('e',64));
    UPDATE deployment_identity SET network='mainnet',deployment_fingerprint=repeat('a',64);
    UPDATE checkpoint_journal SET digest='analytics-checkpoint-'||checkpoint,timestamp_ms=100000+checkpoint,network='mainnet' WHERE checkpoint IN(20,21);
    INSERT INTO watermarks(pipeline,epoch_hi_inclusive,checkpoint_hi_inclusive,tx_hi,timestamp_ms_hi_inclusive,reader_lo,pruner_timestamp,pruner_hi)
    SELECT pipeline,0,20,21,100020,1,now(),0 FROM unnest(ARRAY['intake','market','presale']) pipeline;
    INSERT INTO activity(checkpoint,tx_slot,event_slot,part,timestamp_ms,digest,kind,product,actor,tx_sender,coin_type,quote_type,quote_amount,usd_value,usd_price_as_of_ms)
    VALUES(7,1,0,0,100007,'analytics-tx-7','trade_buy','market','0x'||repeat('1',64),'0x'||repeat('1',64),'0x'||repeat('b',64)||'::coin::B','quote',9007199254740993,999,100007),
    (10,1,0,0,100010,'analytics-tx-10','presale_commit','presale','0x'||repeat('1',64),'0x'||repeat('1',64),'0x'||repeat('b',64)||'::coin::B','quote',2,4,100010);
  `);
  await warehouseAdmin.query(`TRUNCATE blast_analytics.state,blast_analytics.facts,blast_analytics.wallets,
    blast_analytics.transactions,blast_analytics.coins,blast_analytics.trade_receipts,
    blast_analytics.quote_totals,blast_analytics.totals,blast_analytics.snapshots`);
  await replay();
  assert.equal(await refreshAnalytics(config, new AbortController().signal), "refreshed");
});

after(async () => {
  api.close();
  api.closeAllConnections();
  await Promise.all([
    sourceAdmin.end(),
    sourceReader.end(),
    replicaAdmin.end(),
    warehouseAdmin.end(),
    warehouseReader.end(),
  ]);
});

test("collects current receipts exactly once through the private summary API", async () => {
  // Hand-calculated from the fixture's settled amounts and $2 quote feed.
  await assertTradeReceipts([
    {
      fact_id: "swap:4:1:0:0",
      digest: "analytics-tx-4",
      quote_type: "quote",
      quote_amount: "7",
      usd_value: "14",
    },
    {
      fact_id: "swap:5:1:0:0",
      digest: "analytics-tx-5",
      quote_type: "quote",
      quote_amount: "10",
      usd_value: "20",
    },
    {
      fact_id: "swap:7:1:0:0",
      digest: "analytics-tx-7",
      quote_type: "quote",
      quote_amount: "9007199254740993",
      usd_value: "18014398509481986",
    },
    {
      fact_id: "swap:7:1:1:0",
      digest: "analytics-tx-7",
      quote_type: "quote",
      quote_amount: "3",
      usd_value: "6",
    },
    {
      fact_id: "swap:8:1:0:0",
      digest: "analytics-tx-8",
      quote_type: "quote",
      quote_amount: "11",
      usd_value: "22",
    },
  ]);
  const summary = await readSummary();
  assert.equal(summary.asOfCheckpoint, "20");
  assert.deepEqual(summary.quoteTotals, { quote: "9007199254741024" });
  assert.deepEqual(summary.totals.trade_volume, {
    count: "5",
    pricedCount: "5",
    pricedUsd: "18014398509482048.00000000",
  });
  assert.equal(summary.auditedTotalTradeVolumeUsd, "18014398509482048.00000000");
  assert.equal(summary.totals.opening_participation?.count, "1");
  assert.equal(summary.totals.wallet_trade_activity?.count, "1");
  assert.equal(summary.totals.presale_commit?.pricedUsd, "4");
  assert.equal(summary.accountActivity, null);
  assert.deepEqual(summary.users, {
    unit: "active-wallets",
    dau24h: "1",
    mau30d: "1",
    uniqueSinceCoverage: "1",
    productDau: null,
    productMau: null,
  });
  assert.deepEqual(summary.totals.transactions, {
    count: "6",
    pricedCount: "0",
    pricedUsd: "0",
  });
  assert.equal(JSON.stringify(summary).includes(`0x${"1".repeat(64)}`), false);
  await refreshAnalytics(config, new AbortController().signal);
  assert.deepEqual((await readSummary()).totals, summary.totals);
  assert.equal(
    (await warehouseAdmin.query("SELECT count(*)::text AS count FROM blast_analytics.facts"))
      .rows[0].count,
    "8",
  );
});

test("uses each receipt's historical quote policy and leaves an invalid price unpriced", async () => {
  try {
    await sourceAdmin.query(`
      INSERT INTO financial_quote_configs VALUES
        (7, jsonb_build_object('quote',jsonb_build_object('decimals',0,'feed_id','0x'||repeat('d',64))));
      INSERT INTO financial_feed_observations VALUES
        (6,1,1,'0x'||repeat('d',64),300000000,0,-8,100),
        (7,1,2,'0x'||repeat('d',64),300000000,3000001,-8,100);
    `);
    await warehouseAdmin.query(`TRUNCATE blast_analytics.state,blast_analytics.facts,blast_analytics.wallets,
      blast_analytics.transactions,blast_analytics.coins,blast_analytics.trade_receipts,
      blast_analytics.quote_totals,blast_analytics.totals,blast_analytics.snapshots`);
    await replay();
    assert.equal(
      await refreshAnalytics(config, new AbortController().signal),
      "refreshed",
    );
    // The $3 feed starts at checkpoint 7; its later observation fails the 100 bps limit.
    await assertTradeReceipts([
      {
        fact_id: "swap:4:1:0:0",
        digest: "analytics-tx-4",
        quote_type: "quote",
        quote_amount: "7",
        usd_value: "14",
      },
      {
        fact_id: "swap:5:1:0:0",
        digest: "analytics-tx-5",
        quote_type: "quote",
        quote_amount: "10",
        usd_value: "20",
      },
      {
        fact_id: "swap:7:1:0:0",
        digest: "analytics-tx-7",
        quote_type: "quote",
        quote_amount: "9007199254740993",
        usd_value: "27021597764222979",
      },
      {
        fact_id: "swap:7:1:1:0",
        digest: "analytics-tx-7",
        quote_type: "quote",
        quote_amount: "3",
        usd_value: "9",
      },
      {
        fact_id: "swap:8:1:0:0",
        digest: "analytics-tx-8",
        quote_type: "quote",
        quote_amount: "11",
        usd_value: null,
      },
    ]);
    const summary = await readSummary();
    assert.deepEqual(summary.quoteTotals, { quote: "9007199254741024" });
    assert.deepEqual(summary.totals.trade_volume, {
      count: "5",
      pricedCount: "4",
      pricedUsd: "27021597764223022.00000000",
    });
    assert.equal(summary.auditedTotalTradeVolumeUsd, null);
  } finally {
    await sourceAdmin.query(`
      DELETE FROM financial_feed_observations WHERE (checkpoint,tx_slot,event_slot) IN ((6,1,1),(7,1,2));
      DELETE FROM financial_quote_configs WHERE checkpoint=7;
    `);
    await replay();
  }
});

test("rejects a primary database without replacing the last good snapshot", async () => {
  const previous = await readSummary();
  await assert.rejects(
    refreshAnalytics(
      { ...config, sourceUrl: localUrl("ANALYTICS_TEST_PRIMARY_URL") },
      new AbortController().signal,
    ),
    { message: "Analytics extraction requires a physical read replica" },
  );
  assert.deepEqual(await readSummary(), previous);
});

test("rejects a different deployment without replacing the last good snapshot", async () => {
  const previous = await readSummary();
  await assert.rejects(
    refreshAnalytics({ ...config, network: "testnet" }, new AbortController().signal),
    {
      message: "Analytics projection coverage incomplete or deployment mismatch",
    },
  );
  await assert.rejects(
    refreshAnalytics({ ...config, fingerprint: "b".repeat(64) }, new AbortController().signal),
    {
      message: "Analytics projection coverage incomplete or deployment mismatch",
    },
  );
  assert.deepEqual(await readSummary(), previous);
});

test("refuses missing projection coverage rather than treating it as zero activity", async () => {
  await refuses(
    "DELETE FROM watermarks WHERE pipeline='presale'",
    "Analytics projection coverage incomplete or deployment mismatch",
  );
});

test("refuses lag behind its completed cut", async () => {
  await refuses(
    "UPDATE watermarks SET checkpoint_hi_inclusive=19,timestamp_ms_hi_inclusive=100019 WHERE pipeline='market'",
    "Analytics source history changed; rebuild required",
  );
});

test("refuses retention that no longer covers the configured history start", async () => {
  await refuses(
    "UPDATE watermarks SET reader_lo=2 WHERE pipeline='presale'",
    "Analytics projection coverage incomplete or deployment mismatch",
  );
});

test("refuses projection faults before publication", async () => {
  await refuses(
    "INSERT INTO projection_faults VALUES('presale',21,'fixture','fixture')",
    "Analytics projection coverage incomplete or deployment mismatch",
  );
});

test("refuses unresolved registered-pool coverage", async () => {
  await refuses(
    `INSERT INTO sale_coin_faults VALUES(21,1,0,NULL,'pool_price','registration_unreadable','fixture','fixture','fixture',100021)`,
    "Analytics pool registration coverage incomplete",
  );
});

test("refuses archived unread history", async () => {
  await refuses(
    "INSERT INTO archive_cuts VALUES(2026,21,0,0,0,100021,'{}')",
    "Analytics history is archived; restore archive before advancing",
  );
});

test("refuses a changed exclusion policy or hash key instead of mixing scopes", async () => {
  const previous = await readSummary();
  await assert.rejects(
    refreshAnalytics({ ...config, walletKey: "b".repeat(32) }, new AbortController().signal),
    { message: "Analytics scope changed; rebuild required" },
  );
  await refuses(
    "INSERT INTO excluded_sale_packages VALUES('0x'||repeat('f',64))",
    "Analytics scope changed; rebuild required",
  );
  assert.deepEqual(await readSummary(), previous);
});

test("refuses an unknown export policy version", async () => {
  await refuses(
    `CREATE OR REPLACE VIEW chain_read_v1.analytics_policy AS ${policyDefinition.replace("current-lineage-receipts-v1", "unsupported-export-v2")}`,
    "Analytics source policy unavailable or unsupported",
  );
});

test("pins the completed checkpoint digest and timestamp", async () => {
  await refuses(
    "UPDATE checkpoint_journal SET digest='changed' WHERE checkpoint=20",
    "Analytics source history changed; rebuild required",
  );
  await sourceAdmin.query(
    "UPDATE checkpoint_journal SET digest='analytics-checkpoint-20',timestamp_ms=100021 WHERE checkpoint=20",
  );
  await replay();
  await assert.rejects(refreshAnalytics(config, new AbortController().signal), {
    message: "Analytics source history changed; rebuild required",
  });
});

test("requires the same native network cut inside the replica transaction", async () => {
  await refuses(
    "UPDATE checkpoint_journal SET network='testnet' WHERE checkpoint=20",
    "native checkpoint cut is unavailable",
  );
});

test("never silently drops a fact with a mismatched checkpoint timestamp", async () => {
  await seedDenseCheckpoint(1, 100022);
  await seedQuietHead(22);
  await assert.rejects(refreshAnalytics(config, new AbortController().signal), {
    message: "Analytics fact timestamp does not match checkpoint coverage",
  });
  assert.equal((await readSummary()).asOfCheckpoint, "20");
});

test("resumes an oversized checkpoint after a committed partial retry without publishing it", async () => {
  const previous = await readSummary();
  await seedDenseCheckpoint(6001);
  await seedQuietHead(22);
  const batch = await nextBatch();
  assert.ok(batch);
  assert.equal(batch.checkpoint, "21");
  assert.equal(batch.facts.length, 5000);
  assert.equal(batch.complete, false);
  assert.equal(batch.facts[0]!.fact_id, "activity:21:1:0:0");
  const writer = await warehouseAdmin.connect();
  try {
    await importBatch(writer, batch, config.walletKey);
    await importBatch(writer, batch, config.walletKey);
    await publishSnapshot(writer, "22");
  } finally {
    writer.release();
  }
  assert.deepEqual(await readSummary(), previous);
  const remainder = await nextBatch();
  assert.ok(remainder);
  assert.equal(remainder.facts.length, 1001);
  assert.equal(remainder.complete, true);
  assert.equal(await refreshAnalytics(config, new AbortController().signal), "refreshed");
  const summary = await readSummary();
  assert.equal(summary.asOfCheckpoint, "22");
  assert.equal(summary.totals.presale_claim?.count, "6001");
  assert.deepEqual(summary.quoteTotals, { quote: "9007199254741024" });
  assert.equal(
    (await warehouseAdmin.query("SELECT count(*)::text AS count FROM blast_analytics.facts"))
      .rows[0].count,
    "6009",
  );
});

test("pins the pending checkpoint digest and timestamp before keyset resume", async () => {
  await seedDenseCheckpoint(5001);
  const batch = await nextBatch();
  assert.ok(batch);
  const writer = await warehouseAdmin.connect();
  try {
    await importBatch(writer, batch, config.walletKey);
  } finally {
    writer.release();
  }
  await refuses(
    "UPDATE checkpoint_journal SET digest='changed-pending' WHERE checkpoint=21",
    "Analytics pending history changed; rebuild required",
  );
  await sourceAdmin.query(
    "UPDATE checkpoint_journal SET digest='analytics-checkpoint-21',timestamp_ms=100022 WHERE checkpoint=21",
  );
  await replay();
  await assert.rejects(refreshAnalytics(config, new AbortController().signal), {
    message: "Analytics pending history changed; rebuild required",
  });
  await sourceAdmin.query(
    "UPDATE checkpoint_journal SET timestamp_ms=100021 WHERE checkpoint=21; TRUNCATE activity",
  );
  await replay();
  await assert.rejects(refreshAnalytics(config, new AbortController().signal), {
    message: "Analytics pending fact changed; rebuild required",
  });
});

test("bounds quiet reads to 10000 checkpoints and each run to 20 batches", async (context) => {
  context.mock.method(performance, "now", () => 0);
  await seedQuietHead(200025);
  const first = await nextBatch();
  assert.ok(first);
  assert.equal(first.checkpoint, "10020");
  assert.equal(first.facts.length, 0);
  await refreshAnalytics(config, new AbortController().signal);
  assert.equal((await readSummary()).asOfCheckpoint, "200020");
  assert.equal((await readSummary()).catchingUp, true);
  await refreshAnalytics(config, new AbortController().signal);
  assert.equal((await readSummary()).asOfCheckpoint, "200025");
  assert.equal((await readSummary()).catchingUp, false);
});

test("stops before another batch when its soft time budget expires", async (context) => {
  await seedQuietHead(10050);
  const times = [0, 0, 30000];
  context.mock.method(performance, "now", () => times.shift() ?? 30000);
  await refreshAnalytics(config, new AbortController().signal);
  assert.equal((await readSummary()).asOfCheckpoint, "10020");
  assert.equal((await readSummary()).catchingUp, true);
});

test("allows one collector owner and releases its session on every exit", async () => {
  const previous = await readSummary();
  const owner = await warehouseAdmin.connect();
  try {
    await owner.query("SELECT pg_advisory_lock(198401,1)");
    assert.equal(await refreshAnalytics(config, new AbortController().signal), "busy");
    await owner.query("SELECT pg_advisory_unlock(198401,1)");
  } finally {
    owner.release();
  }
  assert.deepEqual(await readSummary(), previous);
  await refreshAnalytics(config, new AbortController().signal);
  assert.equal(
    (await warehouseAdmin.query("SELECT pg_try_advisory_lock(198401,1) AS acquired")).rows[0]
      .acquired,
    true,
  );
  await warehouseAdmin.query("SELECT pg_advisory_unlock(198401,1)");
});

test("keeps the last good snapshot when its source is offline", async () => {
  const previous = await readSummary();
  const offline = new URL(config.sourceUrl);
  offline.port = "1";
  await assert.rejects(
    refreshAnalytics({ ...config, sourceUrl: offline.toString() }, new AbortController().signal),
    { code: "ECONNREFUSED" },
  );
  assert.deepEqual(await readSummary(), previous);
});

test("stops at a query boundary after cancellation and leaves publication untouched", async () => {
  const previous = await readSummary();
  await seedDenseCheckpoint(1);
  const blocker = new Pool({
    connectionString: localUrl("ANALYTICS_TEST_WAREHOUSE_ADMIN_URL"),
    max: 1,
  });
  const owner = await blocker.connect();
  const controller = new AbortController();
  let refresh: Promise<string> | undefined;
  try {
    await owner.query("BEGIN; SELECT * FROM blast_analytics.state FOR UPDATE");
    refresh = refreshAnalytics(config, controller.signal);
    await waitUntil(
      async () =>
        (
          await warehouseAdmin.query(`SELECT EXISTS(SELECT FROM pg_stat_activity
      WHERE application_name='blast-analytics-writer' AND wait_event_type='Lock') AS waiting`)
        ).rows[0].waiting,
    );
    controller.abort();
    await owner.query("ROLLBACK");
    assert.equal(await refresh, "aborted");
  } finally {
    controller.abort();
    await owner.query("ROLLBACK");
    owner.release();
    await blocker.end();
    await refresh;
  }
  assert.deepEqual(await readSummary(), previous);
  assert.equal(await refreshAnalytics(config, new AbortController().signal), "refreshed");
  assert.equal((await readSummary()).asOfCheckpoint, "21");
});

test("keeps publication after a source policy change interrupts committed progress", async () => {
  const previous = await readSummary();
  await seedDenseCheckpoint(100);
  await seedQuietHead(10050);
  const barrier = new Pool({
    connectionString: localUrl("ANALYTICS_TEST_WAREHOUSE_ADMIN_URL"),
    max: 1,
  });
  const owner = await barrier.connect();
  let running: Promise<string> | undefined;
  try {
    await warehouseAdmin.query(`
      CREATE FUNCTION blast_analytics.collector_test_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        WHILE NOT pg_try_advisory_xact_lock(198401,2) LOOP PERFORM pg_sleep(0.01); END LOOP;
        RETURN NEW;
      END $$;
      CREATE TRIGGER collector_test_pause BEFORE UPDATE ON blast_analytics.state
      FOR EACH ROW WHEN(NEW.checkpoint=10020 AND NEW.pending_checkpoint IS NULL)
      EXECUTE FUNCTION blast_analytics.collector_test_pause();
    `);
    await owner.query("SELECT pg_advisory_lock(198401,2)");
    running = refreshAnalytics(config, new AbortController().signal);
    void running.catch(() => {});
    await waitUntil(
      async () =>
        (
          await warehouseAdmin.query(`SELECT EXISTS(SELECT FROM pg_stat_activity
      WHERE application_name='blast-analytics-writer' AND wait_event='PgSleep') AS waiting`)
        ).rows[0].waiting,
    );
    await sourceAdmin.query("INSERT INTO excluded_sale_packages VALUES('0x'||repeat('f',64))");
    await replay();
    await owner.query("SELECT pg_advisory_unlock(198401,2)");
    await assert.rejects(running, { message: "Analytics scope changed; rebuild required" });
    assert.deepEqual(await readSummary(), previous);
    assert.deepEqual(
      (
        await warehouseAdmin.query(`SELECT checkpoint::text,pending_checkpoint::text
      FROM blast_analytics.state WHERE singleton`)
      ).rows[0],
      { checkpoint: "10020", pending_checkpoint: null },
    );
    assert.equal(
      (await warehouseAdmin.query("SELECT count(*)::text AS count FROM blast_analytics.facts"))
        .rows[0].count,
      "108",
    );

    await warehouseAdmin.query(
      "DROP TRIGGER collector_test_pause ON blast_analytics.state; DROP FUNCTION blast_analytics.collector_test_pause()",
    );
    await sourceAdmin.query(
      "DELETE FROM excluded_sale_packages WHERE package_id='0x'||repeat('f',64)",
    );
    await replay();
    assert.equal(await refreshAnalytics(config, new AbortController().signal), "refreshed");
    assert.equal((await readSummary()).asOfCheckpoint, "10050");
    assert.equal((await readSummary()).totals.presale_claim?.count, "100");
    assert.equal(
      (await warehouseAdmin.query("SELECT count(*)::text AS count FROM blast_analytics.facts"))
        .rows[0].count,
      "108",
    );
  } finally {
    await owner.query("SELECT pg_advisory_unlock(198401,2)").catch(() => {});
    await warehouseAdmin
      .query(
        "DROP TRIGGER IF EXISTS collector_test_pause ON blast_analytics.state; DROP FUNCTION IF EXISTS blast_analytics.collector_test_pause()",
      )
      .catch(() => {});
    owner.release();
    await barrier.end();
    await running?.catch(() => {});
  }
});

async function assertTradeReceipts(
  expected: {
    fact_id: string;
    digest: string;
    quote_type: string;
    quote_amount: string;
    usd_value: string | null;
  }[],
) {
  const fields =
    "fact_id,digest,quote_type,quote_amount::text,trim_scale(usd_value)::text AS usd_value";
  const source = await sourceReader.query(
    `SELECT ${fields} FROM chain_read_v1.analytics_facts WHERE kind='trade' ORDER BY fact_id COLLATE "C"`,
  );
  const warehouse = await warehouseAdmin.query(
    `SELECT ${fields} FROM blast_analytics.facts WHERE kind='trade' ORDER BY fact_id COLLATE "C"`,
  );
  assert.deepEqual(source.rows, expected);
  assert.deepEqual(warehouse.rows, expected);
}

async function readSummary(): Promise<
  Snapshot["payload"] & { generatedAt: string; stale: boolean }
> {
  const response = await fetch(`${apiUrl}/v1/summary`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function replay() {
  const lsn = (await sourceAdmin.query("SELECT pg_current_wal_lsn()::text AS lsn")).rows[0].lsn;
  await waitUntil(
    async () =>
      (await replicaAdmin.query("SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS replayed", [lsn]))
        .rows[0].replayed,
  );
}

async function waitUntil(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await delay(20);
  }
  assert.fail("Disposable replica/collector condition did not become ready");
}

async function refuses(corruption: string, message: string) {
  const previous = await readSummary();
  await sourceAdmin.query(corruption);
  await replay();
  await assert.rejects(refreshAnalytics(config, new AbortController().signal), {
    message,
  });
  assert.deepEqual(await readSummary(), previous);
}

async function advanceCoverage(checkpoint: number) {
  await sourceAdmin.query(
    "UPDATE watermarks SET checkpoint_hi_inclusive=$1::bigint,timestamp_ms_hi_inclusive=100000+$1::bigint",
    [checkpoint],
  );
  await replay();
}

async function seedDenseCheckpoint(count: number, timestamp = 100021) {
  await sourceAdmin.query(`INSERT INTO checkpoint_journal(checkpoint,network,digest,previous_digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash,encoded_len)
    VALUES(21,'mainnet','analytics-checkpoint-21',NULL,0,100021,0,2,NULL,decode(repeat('00',32),'hex'),0) ON CONFLICT DO NOTHING`);
  await sourceAdmin.query(
    `INSERT INTO activity(checkpoint,tx_slot,event_slot,part,timestamp_ms,digest,kind,product,actor,tx_sender,coin_type,quote_type,quote_amount)
    SELECT 21,1,n,0,$2,'dense-tx-'||n,'presale_claim','presale','0x'||repeat('2',64),'0x'||repeat('2',64),'dense::coin::D','quote',0
    FROM generate_series(0,$1::integer-1) n`,
    [count, timestamp],
  );
  await advanceCoverage(21);
}

async function seedQuietHead(checkpoint: number) {
  await sourceAdmin.query(
    `INSERT INTO checkpoint_journal(checkpoint,network,digest,previous_digest,epoch,timestamp_ms,total_transactions,format_version,payload,payload_hash,encoded_len)
    SELECT cp,'mainnet','analytics-checkpoint-'||cp,NULL,0,100000+cp,0,2,NULL,decode(repeat('00',32),'hex'),0
    FROM generate_series(21,$1::integer) cp ON CONFLICT DO NOTHING`,
    [checkpoint],
  );
  await advanceCoverage(checkpoint);
}

async function nextBatch() {
  const cursor = (
    await warehouseAdmin.query<Cursor>(`SELECT checkpoint::text,digest,timestamp_ms::text,
    pending_checkpoint::text,pending_digest,pending_timestamp_ms::text,pending_fact_id FROM blast_analytics.state WHERE singleton`)
  ).rows[0]!;
  const pool = analyticsPool(config.sourceUrl, "analytics-test-extractor");
  const reader = await pool.connect();
  try {
    return (await readFactBatch(reader, config, cursor)).batch;
  } finally {
    reader.release(true);
    await pool.end();
  }
}
