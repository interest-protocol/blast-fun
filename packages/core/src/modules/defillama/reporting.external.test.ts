import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Pool } from "pg";
import { DefillamaAccounting } from "./accounting.ts";
import { HOUR_SECONDS, hourStarts } from "./contracts.ts";
import { collectDay, collectHour } from "./source.ts";
import { loadReplayBase, publishSnapshot, reportingReads, type ReplayBase } from "./store.ts";
import { createDefillamaRead } from "./reads.ts";
import {
  day,
  end,
  launchEvent,
  vaultEvent,
  objectId,
  profile,
  quote,
  start,
} from "./fixtures.test.ts";

const run = promisify(execFile);
const infra = process.env.DEFILLAMA_INFRA_CHECKOUT;
const bin = process.env.PG_BIN ?? "/usr/lib/postgresql/16/bin";

test(
  "real replica receipts → atomic reporting publication → bounded HTTP pages and corrections",
  { skip: !infra, timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "blast-defillama-"));
    const primaryDir = join(root, "primary"),
      replicaDir = join(root, "replica");
    const primaryPort = await freePort(),
      replicaPort = await freePort();
    const primarySocket = join(root, "psock"),
      replicaSocket = join(root, "rsock");
    await Promise.all([mkdir(primarySocket), mkdir(replicaSocket)]);
    const pools: Pool[] = [];
    const started: string[] = [];
    t.after(async () => {
      await Promise.all(pools.map((pool) => pool.end()));
      for (const directory of started.reverse()) {
        await run(join(bin, "pg_ctl"), ["-D", directory, "-m", "immediate", "-w", "stop"]);
      }
      await rm(root, { recursive: true, force: true });
    });
    await run(join(bin, "initdb"), [
      "-D",
      primaryDir,
      "-U",
      "postgres",
      "--auth=trust",
      "--no-locale",
    ]);
    await startDatabase(
      primaryDir,
      primaryPort,
      primarySocket,
      "-c wal_level=replica -c max_wal_senders=3",
    );
    started.push(primaryDir);
    function pool(port: number, database: string, user = "postgres") {
      const p = new Pool({
        host: "127.0.0.1",
        port,
        database,
        user,
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      pools.push(p);
      return p;
    }
    const admin = pool(primaryPort, "postgres");
    await admin.query("CREATE DATABASE source");
    await admin.query("CREATE DATABASE reporting");
    const sourceOwner = pool(primaryPort, "source");
    await sourceOwner.query(`
    CREATE ROLE blast_indexer; CREATE ROLE blast_web; CREATE ROLE blast_watcher; CREATE ROLE blast_social; CREATE ROLE blast_replica;
    CREATE SCHEMA blast_infra AUTHORIZATION blast_indexer;
    CREATE SCHEMA chain_read_v1; GRANT USAGE,CREATE ON SCHEMA chain_read_v1 TO blast_indexer;
    SET search_path=blast_infra,public;
    CREATE TABLE deployment_identity(network TEXT, deployment_fingerprint TEXT);
    CREATE TABLE watermarks(pipeline TEXT PRIMARY KEY, reader_lo BIGINT, checkpoint_hi_inclusive BIGINT, timestamp_ms_hi_inclusive BIGINT);
    ALTER TABLE deployment_identity OWNER TO blast_indexer; ALTER TABLE watermarks OWNER TO blast_indexer;
  `);
    await sourceOwner.query(
      await readFile(join(infra!, "migrations/2026-10-27-100000_shared_intake/up.sql"), "utf8"),
    );
    await sourceOwner.query(
      "CREATE VIEW chain_read_v1.checkpoint_headers AS SELECT checkpoint,digest,timestamp_ms FROM blast_infra.checkpoint_journal; ALTER VIEW chain_read_v1.checkpoint_headers OWNER TO blast_indexer",
    );
    const sourceMigration = await readFile(
      join(infra!, "migrations/2026-11-12-000000_defillama_source/up.sql"),
      "utf8",
    );
    await sourceOwner.query(sourceMigration);
    await sourceOwner.query(
      "CREATE ROLE def_source LOGIN; GRANT blast_defillama_source TO def_source",
    );
    await sourceOwner.query("INSERT INTO deployment_identity VALUES ($1,$2)", [
      profile.network,
      profile.deployment_fingerprint,
    ]);
    await sourceOwner.query("INSERT INTO watermarks VALUES ('intake',100,105,$1)", [end]);
    for (const [cp, time] of [
      [100, start - 3000],
      [101, start - 2000],
      [102, start + 100],
      [103, start + HOUR_SECONDS * 1000],
      [104, start + HOUR_SECONDS * 1000 + 1000],
      [105, end],
    ]) {
      await sourceOwner.query(
        `INSERT INTO checkpoint_journal VALUES ($1,'mainnet',$2,NULL,0,$3,1,1,''::BYTEA,decode(repeat('00',32),'hex'))`,
        [cp, `digest-${cp}`, time],
      );
      await sourceOwner.query("INSERT INTO native_transactions VALUES ($1,1,$2,$3,$3,$4,0)", [
        cp,
        `transaction-${cp}`,
        objectId("5"),
        cp !== 104,
      ]);
    }
    for (let i = 0; i < 201; i++) {
      const launch = `0x${(i + 10000).toString(16).padStart(64, "0")}`;
      const ticket = `0x${(i + 20000).toString(16).padStart(64, "0")}`;
      const meme = `0x${(i + 30000).toString(16).padStart(64, "0")}::m::Coin`;
      const events = [
        [101, launchEvent("LaunchTicketCreated", { ticket_id: ticket }, undefined, meme)],
        [
          102,
          launchEvent("LaunchCreated", {
            launch_id: launch,
            ticket_id: ticket,
            creation_fee: 10n,
          }, undefined, meme),
        ],
        [
          103,
          launchEvent("Bought", {
            launch_id: launch,
            quote_in: 9_007_199_254_740_993n,
            protocol_quote_fee: 8n,
            creator_quote_fee: 2n,
            protocol_meme_fee: 1n,
          }, undefined, meme),
        ],
      ] as const;
      for (const [cp, event] of events) {
        await sourceOwner.query("INSERT INTO native_events VALUES ($1,1,$2,$3,$4,$5,$6)", [
          cp,
          i,
          profile.launchpad_original_package,
          event.event_type,
          event.sender,
          Buffer.from(event.bcs),
        ]);
      }
    }
    const feeEvents = [
      launchEvent("ProtocolFeesAccrued", {
        launch_id: `0x${(10000).toString(16).padStart(64, "0")}`,
        quote_amount: 33n,
        meme_amount: 55n,
      }),
      vaultEvent("VaultCreated", { residual_quote_amount: 999n }),
      vaultEvent("FeesCollected", {
        gross_quote_amount: 20n, protocol_quote_amount: 7n, route_quote_amounts: [13n],
      }),
      vaultEvent("FeesCollected", {
        gross_quote_amount: 10n, protocol_quote_amount: 2n, route_quote_amounts: [8n],
      }),
    ];
    for (const [index, event] of feeEvents.entries()) {
      await sourceOwner.query("INSERT INTO native_events VALUES (103,1,$1,$2,$3,$4,$5)", [
        1000 + index,
        event.event_type.split("::")[0],
        event.event_type,
        event.sender,
        Buffer.from(event.bcs),
      ]);
    }
    const bad = launchEvent("Bought", { quote_in: 1n }); // failed transaction must never reach the SDK/accounting
    await sourceOwner.query("INSERT INTO native_events VALUES (104,1,0,$1,$2,$3,$4)", [
      profile.launchpad_original_package,
      bad.event_type,
      bad.sender,
      Buffer.from(bad.bcs),
    ]);
    const reportingOwner = pool(primaryPort, "reporting");
    await reportingOwner.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
    await reportingOwner.query(
      "CREATE ROLE def_reader LOGIN; CREATE ROLE def_writer LOGIN; GRANT blast_defillama_reader TO def_reader; GRANT blast_defillama_publisher TO def_writer",
    );
    await run(join(bin, "pg_basebackup"), [
      "-h",
      "127.0.0.1",
      "-p",
      String(primaryPort),
      "-U",
      "postgres",
      "-D",
      replicaDir,
      "-R",
      "-X",
      "stream",
      "-c",
      "fast",
    ]);
    await startDatabase(replicaDir, replicaPort, replicaSocket);
    started.push(replicaDir);
    const source = pool(replicaPort, "source", "def_source");
    const writer = pool(primaryPort, "reporting", "def_writer");
    const reader = pool(primaryPort, "reporting", "def_reader");
    const snapshot = await collectDay(source, profile, day, end + 1000);
    assert.equal(snapshot.contracts.length, 202);
    assert.equal(snapshot.items.find((i) => i.component === "migration")?.metrics.fees, "33");
    const collection = snapshot.items.find((i) => i.component === "vault_collections")!;
    assert.equal(collection.metrics.fees, "30");
    assert.equal(collection.metrics.revenue, "9");
    assert.equal(
      snapshot.items.find((i) => i.component === "curve_swaps" && i.coin_type === quote)?.metrics
        .volume,
      String(9_007_199_254_740_993n * 201n),
    );
    const previousFormat = { ...snapshot, daily_launch_stats: undefined };
    const first = await publishSnapshot(writer, previousFormat);
    assert.equal(first.revision, 1);
    assert.deepEqual(await publishSnapshot(writer, previousFormat), first);
    const nextDay = "2026-10-21";
    const base = await loadReplayBase(writer, profile, nextDay);
    assert.equal(base?.source.checkpoint, "105");
    await assert.rejects(loadReplayBase(reader, profile, nextDay), /permission denied/);
    const reads = reportingReads(reader, profile);
    assert.equal((await reads.publication({ date: day })).summary.daily_launch_stats, undefined);
    const read = createDefillamaRead(
      () => reads,
      () => end + 1000,
    );
    const url = `http://test/api/v1/defillama/metrics?date=${day}`;
    const page1 = await (await read(new Request(url))).json();
    assert.equal(page1.items.length, 100);
    assert.equal(page1.frontend_fee_coverage.status, "unavailable");
    assert.equal(page1.coverage.fees.status, "unavailable");
    assert.equal(page1.scope_coverage.launchpad.fees.status, "complete");
    assert.equal(page1.scope_coverage.frontend_router.fees.status, "unavailable");
    assert.equal(page1.scope_coverage.vault_yield.revenue.status, "complete");
    assert.ok(page1.next_cursor);
    const feesUrl = `http://test/api/v1/defillama/fees?date=${day}`;
    assert.equal((await read(new Request(feesUrl))).status, 404);

    const accounting = new DefillamaAccounting(profile, start, end);
    const cetusPaid = 9_007_199_254_740_993n;
    const frontendFees = [
      { id: "cetus-receipt", venue: "cetus", coin: quote, amount: cetusPaid },
      { id: "aftermath-receipt", venue: "aftermath", coin: quote, amount: 17n },
    ] as const;
    accounting.addFrontendFees(frontendFees);
    const frontend = accounting.result();
    const corrected = {
      ...snapshot,
      scope_coverage: {
        ...snapshot.scope_coverage,
        frontend_router: frontend.scope_coverage.frontend_router,
      },
      frontend_fee_coverage: { status: "complete", reason: null } as const,
      items: [...snapshot.items, ...frontend.items],
    };
    const second = await publishSnapshot(writer, corrected);
    assert.equal(second.revision, 2);
    assert.deepEqual(await publishSnapshot(writer, corrected), second);
    const fees = await (await read(new Request(feesUrl))).json();
    assert.equal(fees.snapshot_id, second.id);
    assert.equal(fees.revision, 2);
    assert.equal(fees.date, day);
    const sui = "sui:0x2::sui::SUI";
    for (const breakdown of [fees.dailyFees, fees.dailyRevenue]) {
      assert.deepEqual(breakdown.cetus, { [sui]: cetusPaid.toString() });
      assert.deepEqual(breakdown.aftermath, { [sui]: "17" });
      assert.equal(breakdown.vault_collections, undefined);
      assert.equal(breakdown.frontend_router_fees, undefined);
    }
    assert.deepEqual(fees.dailySupplySideRevenue, { curve_swaps: { [sui]: "402" } });
    assert.equal(fees.dailyFees.curve_swaps[sui], "2010");
    assert.equal(fees.dailyRevenue.curve_swaps[sui], "1608");
    assert.equal((await read(new Request(feesUrl + "&cursor=unexpected"))).status, 400);
    const hour = start / 1000;
    const hourUrl = (from: number, to: number) =>
      `http://test/api/v1/defillama/fees?start_timestamp=${from}&end_timestamp=${to}`;
    assert.equal((await read(new Request(hourUrl(hour, end / 1000)))).status, 404);
    let hourBase: ReplayBase | undefined;
    for (const [index, from] of hourStarts(hour, end / 1000, end).entries()) {
      const native = await collectHour(source, profile, from, end, {
        replayBase: hourBase,
      });
      hourBase = {
        source: native.source,
        state: native.native_replay!,
        contracts: native.contracts,
      };
      const frontend = new DefillamaAccounting(profile, from * 1000, (from + HOUR_SECONDS) * 1000);
      frontend.addFrontendFees(frontendFees.slice(index, index + 1));
      const attributed = frontend.result();
      const hourly = {
        ...native,
        frontend_fee_coverage: { status: "complete", reason: null } as const,
        scope_coverage: {
          ...native.scope_coverage,
          frontend_router: attributed.scope_coverage.frontend_router,
        },
        items: [...native.items, ...attributed.items],
      };
      const publication = await publishSnapshot(writer, hourly);
      assert.deepEqual(await publishSnapshot(writer, hourly), publication);
    }
    const firstHour = await (await read(new Request(hourUrl(hour, hour + HOUR_SECONDS)))).json();
    assert.deepEqual(firstHour.dailyFees.cetus, {
      [sui]: cetusPaid.toString(),
    });
    assert.equal(firstHour.dailyFees.aftermath, undefined);
    assert.equal(firstHour.dailyFees.curve_swaps, undefined);
    const secondHour = await (
      await read(new Request(hourUrl(hour + HOUR_SECONDS, hour + 2 * HOUR_SECONDS)))
    ).json();
    assert.deepEqual(secondHour.dailyFees.aftermath, { [sui]: "17" });
    assert.equal(secondHour.dailyFees.curve_swaps[sui], "2010");
    assert.equal(secondHour.dailyFees.vault_collections, undefined);
    const rolledUp = await (await read(new Request(hourUrl(hour, end / 1000)))).json();
    for (const metric of ["dailyFees", "dailyRevenue", "dailySupplySideRevenue"]) {
      assert.deepEqual(rolledUp[metric], fees[metric]);
    }
    const latest = await reads.publication({ date: day });
    assert.equal(latest.id, second.id);
    assert.deepEqual(latest.summary.daily_launch_stats, {
      launches: 201,
      graduations: 0,
      volume: [{ quote_coin_type: quote, amount_atomic: "1810447050202939593" }],
    });

    let cursor = page1.next_cursor;
    let count = 100;
    while (cursor) {
      const page = await (await read(new Request(`${url}&cursor=${cursor}`))).json();
      assert.equal(page.revision, 1);
      assert.equal(page.snapshot_id, first.id);
      count += page.items.length;
      cursor = page.next_cursor;
    }
    assert.equal(count, snapshot.items.length);
    assert.equal((await (await read(new Request(url))).json()).revision, 2);
    const metadataResponse = await read(new Request("http://test/api/v1/defillama/metadata"));
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.deepEqual(metadata.metrics.volume.available_ranges, [{ from: day, through: day }]);
    assert.equal(metadata.deployment_fingerprint, profile.deployment_fingerprint);
    const reorderedProfile = Object.fromEntries(
      Object.entries(profile).reverse(),
    ) as typeof profile;
    assert.equal(
      (await reportingReads(reader, reorderedProfile).publications()).latest?.revision,
      2,
    );
    assert.equal(
      (await read(new Request("http://test/api/v1/defillama/metrics?date=2026-10-19"))).status,
      404,
    );
    assert.equal(
      (
        await (
          await read(
            new Request(`http://test/api/v1/defillama/contracts?timestamp=${start / 1000}`),
          )
        ).json()
      ).items.length,
      0,
    );
    let contractCursor: string | null = null;
    const ids: string[] = [];
    do {
      const body = await (
        await read(
          new Request(
            `http://test/api/v1/defillama/contracts?timestamp=${hour + HOUR_SECONDS}${contractCursor ? `&cursor=${contractCursor}` : ""}`,
          ),
        )
      ).json();
      ids.push(...body.items.map((i: { object_id: string }) => i.object_id));
      contractCursor = body.next_cursor;
    } while (contractCursor);
    assert.equal(new Set(ids).size, 202);
    await assert.rejects(
      reader.query("INSERT INTO defillama.items VALUES ($1,999,'{}')", [first.id]),
      /permission denied/,
    );
    await assert.rejects(writer.query("DELETE FROM defillama.snapshots"), /permission denied/);
    await assert.rejects(
      source.query("SELECT * FROM blast_infra.native_events"),
      /permission denied/,
    );
    await assert.rejects(
      collectDay(sourceOwner, profile, day, end + 1000),
      /physical read replica/,
    );
    await assert.rejects(
      collectDay(source, { ...profile, first_checkpoint: "99" }, day, end + 1000),
      /precedes verified history/,
    );
    await assert.rejects(
      collectDay(source, { ...profile, deployment_fingerprint: "b".repeat(64) }, day, end + 1000),
      /deployment start/,
    );
    await assert.rejects(
      collectDay(source, profile, "2026-10-21", end + 86_400_000),
      /not completed the interval/,
    );
    assert.equal(
      (await reportingReads(reader, { ...profile, policy_version: "new-policy" }).publications())
        .days.length,
      0,
    );
    const dayEnd = end + 86_400_000;
    await sourceOwner.query(
      `INSERT INTO checkpoint_journal VALUES (106,'mainnet','digest-106',NULL,0,$1,0,1,''::BYTEA,decode(repeat('00',32),'hex'))`,
      [dayEnd],
    );
    const collected = vaultEvent("FeesCollected", {
      gross_quote_amount: 11n, protocol_quote_amount: 3n, route_quote_amounts: [8n],
    });
    await sourceOwner.query("INSERT INTO native_events VALUES (105,1,0,$1,$2,$3,$4)", [
      profile.vault_original_package, collected.event_type, collected.sender, Buffer.from(collected.bcs),
    ]);
    await sourceOwner.query(
      "UPDATE watermarks SET checkpoint_hi_inclusive=106,timestamp_ms_hi_inclusive=$1 WHERE pipeline='intake'",
      [dayEnd],
    );
    await waitReplica(sourceOwner, source);
    const nextFull = await collectDay(source, profile, nextDay, dayEnd + 1000);
    const sourceFingerprint = "b".repeat(64);
    await sourceOwner.query("UPDATE deployment_identity SET deployment_fingerprint=$1", [sourceFingerprint]);
    await waitReplica(sourceOwner, source);
    await assert.rejects(collectDay(source, profile, nextDay, dayEnd + 1000), /deployment start/);
    const nextResumed = await collectDay(source, profile, nextDay, dayEnd + 1000, {
      replayBase: base, sourceFingerprint,
    });
    assert.deepEqual(nextResumed, nextFull);
    assert.equal(nextResumed.items.find((i) => i.component === "vault_collections")?.metrics.fees, "11");
    const nextPublication = await publishSnapshot(writer, nextResumed);
    assert.deepEqual(await publishSnapshot(writer, nextFull), nextPublication);
    await sourceOwner.query(
      "INSERT INTO blast_infra.projection_faults VALUES ('intake',103,'unknown','fixture fault')",
    );
    await waitReplica(sourceOwner, source);
    await assert.rejects(collectDay(source, profile, day, end + 1000, { sourceFingerprint }), /unavailable or faulty/);
    // A failed transaction cannot leave a visible snapshot header or page.
    await assert.rejects(
      publishSnapshot(writer, {
        ...snapshot,
        source: { ...snapshot.source, digest: "bad" },
        contracts: [{ ...snapshot.contracts[0]!, created_timestamp_ms: -1 }],
      }),
      /check constraint/,
    );
    assert.equal((await reads.publication({ date: day })).revision, 2);

    async function startDatabase(directory: string, port: number, socket: string, extra = "") {
      await run(join(bin, "pg_ctl"), [
        "-D",
        directory,
        "-l",
        join(directory, "server.log"),
        "-o",
        `-h 127.0.0.1 -p ${port} -k ${socket} -c shared_buffers=16MB -c max_connections=12 ${extra}`,
        "-w",
        "start",
      ]);
    }
  },
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitReplica(primary: Pool, replica: Pool): Promise<void> {
  const result = await primary.query<{ lsn: string }>("SELECT pg_current_wal_lsn()::TEXT AS lsn");
  for (let i = 0; i < 50; i++) {
    if (
      (
        await replica.query("SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS ready", [
          result.rows[0]!.lsn,
        ])
      ).rows[0].ready
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Replica failed to catch up");
}
