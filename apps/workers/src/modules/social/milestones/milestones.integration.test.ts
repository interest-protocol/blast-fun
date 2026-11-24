import { withSocialCoverage } from "../../../../test/fixtures/modules/social/worker/shared-evidence-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  seedChainRead,
  type ChainActivityRow,
  type ChainCoinHolderHistoryRow,
  type ChainPresaleRow,
} from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { FIXTURE_NETWORK, FIXTURE_FINGERPRINT, advanceWatermark, urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { forYouEntries } from "@blast/server/modules/social/feed/for-you.ts";
import { createSocialAlerts } from "#workers/modules/social/worker/alerts.ts";
import { createSocialWorker, type SocialWorker } from "../worker/runtime.ts";
import { milestoneSteps } from "#workers/modules/social/milestones/generate.ts";
import { hex } from "../../../../../../packages/core/test/kit.ts";

/**
 * Social-feed T-027 and T-029 on a disposable database: the milestone steps
 * on the social worker runtime as `blast_watcher` over the fixture
 * `chain_read_v1` views, three presales' commits and a sale coin's holder
 * history read in small batches, then For You as `blast_replica`.
 *
 * blast-infra's real `chain_read_v1.coin_holder_history` does not exist yet
 * (blast-infra T-037 is unmerged), so T-029 runs against the web's fixture
 * view of it (`role-fixtures.ts` `CHAIN_FIXTURE`), exactly as T-027 runs
 * against the fixture `activity`.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 2, statementTimeoutMs: 5_000 };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.now();
const MILESTONES = [10, 50, 100, 250];
const HOLDER_MILESTONES = [100, 250, 500];

const P1 = hex("1111e5");
const P2 = hex("2222e5");
const P3 = hex("3333e5");
const P4 = hex("7777e5");
const P5 = hex("8888e5");

/** A checkpoint's time, as `commit` dates it: one minute per checkpoint, two hours ago at 1,000. */
const at = (checkpoint: number) => NOW - 2 * HOUR + (checkpoint - 1_000) * 60_000;

function presale(id: string, name: string, overrides: Partial<ChainPresaleRow> = {}): ChainPresaleRow {
  return {
    presale_id: id, sale_token: `${id}::coin::${name.toUpperCase()}`, quote_type: `${hex("dc")}::usdc::USDC`, sale_symbol: name.toUpperCase(),
    sale_name: name, sale_icon_url: `https://cdn.blast.fun/${name}.png`, sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6,
    lifecycle: "open", start_ms: NOW - 2 * DAY, end_ms: NOW + DAY, raise_target: "1000000000", min_commitment: "1000000",
    wallet_cap: null, total_commitments: "0", participants: 0, venue: "cetus", pool_id: null, updated_checkpoint: 1_000,
    ...overrides,
  };
}

let slot = 0;
/** A commit at `checkpoint` (one minute per checkpoint, two hours ago at 1,000). */
function commit(checkpoint: number, presaleId: string, participants: number, total: string, fields: Partial<ChainActivityRow> = {}): ChainActivityRow {
  slot += 1;
  const actor = hex(`a${slot.toString(16)}`);
  return {
    checkpoint, tx_slot: slot, event_slot: 0, part: 0, timestamp_ms: at(checkpoint),
    digest: `Ms${slot}`.padEnd(44, "1"), kind: "presale_commit", product: "presale", actor, tx_sender: actor, presale_id: presaleId,
    coin_type: null, quote_type: `${hex("dc")}::usdc::USDC`, quote_amount: "1000000", coin_amount: null, quote_refund: null,
    usd_value: "1", usd_price_as_of_ms: null, venue: null, participants_after: participants, total_commitments_after: total,
    ...fields,
  };
}
/** A holder-history row of `coin` at `checkpoint`. */
const history = (coin: string, checkpoint: number, holders: number): ChainCoinHolderHistoryRow =>
  ({ coin_type: coin, checkpoint, timestamp_ms: at(checkpoint), holders });

/** The presale pipeline committing `checkpoint`, dated as `commit` dates it (checkpoint times never go back). */
const mark = (checkpoint: number) => advanceWatermark(checkpoint, 2 * HOUR - (checkpoint - 1_000) * 60_000, "presale");
/** The market pipeline committing `checkpoint` (the fixture starts both pipelines far ahead of these tests). */
const markMarket = (checkpoint: number) => advanceWatermark(checkpoint, 2 * HOUR - (checkpoint - 1_000) * 60_000, "market");
const activityId = (row: ChainActivityRow) => `${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`;

type Milestone = { entry_id: string; presale_id: string; kind: string; value: string; activity_id: string | null; digest: string | null; timestamp_ms: string; coin_type: string | null };

async function milestones(admin: Pool): Promise<Milestone[]> {
  const { rows } = await admin.query<Milestone>(
    "SELECT entry_id, presale_id, kind, value::text, activity_id, digest, timestamp_ms::text, coin_type FROM social_milestones ORDER BY entry_id COLLATE \"C\"",
  );
  return rows;
}

const expected = (presaleId: string, kind: string, value: string, row: ChainActivityRow): Milestone => ({
  entry_id: `m:${presaleId}:${kind}:${value}`, presale_id: presaleId, kind, value, activity_id: activityId(row), digest: row.digest,
  timestamp_ms: String(row.timestamp_ms), coin_type: null,
});

const expectedHolders = (presaleId: string, coin: string, value: string, row: ChainCoinHolderHistoryRow): Milestone => ({
  entry_id: `m:${presaleId}:holders:${value}`, presale_id: presaleId, kind: "holders", value, activity_id: null, digest: null,
  timestamp_ms: String(row.timestamp_ms), coin_type: coin,
});

type Fixture = Readonly<{
  admin: Pool;
  watcher: Pool;
  replica: Pool;
  worker: (milestones?: readonly number[], holders?: readonly number[]) => SocialWorker;
  lines: Array<Record<string, unknown>>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const watcher = createRuntimePool(urlAs(database.url, "blast_watcher"), POOL, "milestones-watcher-test");
  const replica = createRuntimePool(urlAs(database.url, "blast_replica"), POOL, "milestones-replica-test");
  const lines: Array<Record<string, unknown>> = [];
  try {
    const log = (metric: string, fields: Record<string, unknown> = {}) => void lines.push({ metric, ...fields });
    let holder = 0;
    const worker = (values: readonly number[] = MILESTONES, holders: readonly number[] = HOLDER_MILESTONES) => {
      holder += 1;
      return withSocialCoverage(createSocialWorker({
        selection: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT },
        pool: watcher,
        steps: milestoneSteps({
          batchSize: 2,
          participantMilestones: async () => values,
          holderMilestones: async () => holders,
        }),
        config: { intervalMs: 50, maxBackoffMs: 400, leaseTtlMs: 5_000 },
        holder: `00000000-0000-4000-8000-${holder.toString(16).padStart(12, "0")}`,
        log,
        alerts: createSocialAlerts({ webhookUrl: null, log }),
      }), admin);
    };
    await run({ admin, watcher, replica, worker, lines });
  } finally {
    await Promise.all([watcher.end(), replica.end()]);
    await admin.end();
    await database.drop();
  }
}

/** Passes until the step's cursor reaches the watermark (each pass reads at most two commits); the milestones written. */
async function drain(admin: Pool, worker: SocialWorker): Promise<number> {
  let total = 0;
  for (let index = 0; index < 50; index += 1) {

    const report = await worker.runPass();
    assert.equal(report.outcome, "ok");
    total += report.counts.milestones_written;
    const { rows } = await admin.query<{ c: number; t: number }>("SELECT (value->>'c')::bigint AS c, (value->>'t')::int AS t FROM social_worker_state WHERE name = 'milestone-commits'");
    const bound = report.bounds["milestone-commits"];
    if (rows[0] && bound && Number(rows[0].c) >= bound.checkpoint && rows[0].t === 2_147_483_647) return total;
  }
  throw new Error("the milestone step never reached the watermark");
}

// P1: 9 → 12 → 55 → 56 (10 and 50). P2: 5 → 120 in one commit (10, 50 and 100), then 300 past the watermark.
// P3: totals 400 → 990 → 1,000 (the target) → 1,500, and participants 3 → 4 → 5 → 6 (none).
const p1 = [commit(1_001, P1, 9, "9000000"), commit(1_003, P1, 12, "12000000"), commit(1_005, P1, 55, "55000000"), commit(1_008, P1, 56, "56000000")];
const p2 = [commit(1_002, P2, 5, "5000000"), commit(1_004, P2, 120, "120000000")];
const p3 = [
  commit(1_002, P3, 3, "400000000"), commit(1_006, P3, 4, "990000000"), commit(1_007, P3, 5, "1000000000"), commit(1_009, P3, 6, "1500000000"),
];
const late = commit(1_020, P2, 300, "300000000");
// A claim and a trade carry no counters and are never read.
const other = [
  commit(1_004, P1, 0, "0", { kind: "presale_claim", participants_after: null, total_commitments_after: null }),
  commit(1_005, P3, 0, "0", { kind: "trade_buy", product: "market", presale_id: null, participants_after: null, total_commitments_after: null }),
];

async function seed(admin: Pool): Promise<void> {
  await seedChainRead(admin, {
    presales: [
      presale(P1, "Meridian", { participants: 56 }),
      presale(P2, "Sable", { participants: 300 }),
      presale(P3, "Tidal", { raise_target: "1000000000", total_commitments: "1500000000", participants: 6 }),
    ],
    activity: [...p1, ...p2, ...p3, late, ...other],
  });
  await admin.query(mark(1_010));
}

const AC1 = (): Milestone[] => [
  expected(P1, "participants", "10", p1[1]!),
  expected(P1, "participants", "50", p1[2]!),
  expected(P2, "participants", "10", p2[1]!),
  expected(P2, "participants", "100", p2[1]!),
  expected(P2, "participants", "50", p2[1]!),
  expected(P3, "raise", "1000000000", p3[2]!),
].sort((a, b) => (a.entry_id < b.entry_id ? -1 : 1));

test("T-027-AC-1 (AC-049): one participant milestone per value a commit reaches or passes, with that commit's time and digest", { skip }, () =>
  withDatabase(async ({ admin, worker, lines }) => {
    await seed(admin);
    const one = worker();
    assert.equal(await drain(admin, one), 6);
    assert.deepEqual(await milestones(admin), AC1());
    // The pass metric reports the entries written.
    const passes = lines.filter((line) => line.metric === "social.worker.pass");
    assert.equal(passes.reduce((sum, line) => sum + Number(line.milestones_written), 0), 6);
    // Never past the watermark: P2's 300 waits for it, then crosses 250 alone.
    assert.ok(!(await milestones(admin)).some((row) => row.entry_id === `m:${P2}:participants:250`));
    await admin.query(mark(1_030));
    assert.equal(await drain(admin, one), 1);
    assert.deepEqual((await milestones(admin)).find((row) => row.entry_id === `m:${P2}:participants:250`), expected(P2, "participants", "250", late));
    await one.release();
  }));

test("T-027-AC-2 (AC-050): reaching the raise target writes one raise entry; a later commit adds none", { skip }, () =>
  withDatabase(async ({ admin, worker }) => {
    await seed(admin);
    const one = worker();
    await drain(admin, one);
    const raise = (await milestones(admin)).filter((row) => row.kind === "raise");
    assert.deepEqual(raise, [expected(P3, "raise", "1000000000", p3[2]!)]);
    // A later commit past the target (and one that oversubscribes it further) adds nothing.
    await seedChainRead(admin, { activity: [commit(1_040, P3, 7, "2500000000")] });
    await admin.query(mark(1_050));
    // (Only P2's 300 participants, past 250, is new.)
    assert.equal(await drain(admin, one), 1);
    assert.deepEqual((await milestones(admin)).filter((row) => row.kind === "raise"), raise);
    // A commit that jumps straight past an untouched target writes it at that commit.
    await seedChainRead(admin, {
      presales: [presale(hex("4444e5"), "Cobalt", { raise_target: "500000000" })],
      activity: [commit(1_051, hex("4444e5"), 1, "100000000"), commit(1_052, hex("4444e5"), 2, "900000000")],
    });
    await admin.query(mark(1_060));
    assert.equal(await drain(admin, one), 1);
    assert.equal((await milestones(admin)).filter((row) => row.kind === "raise").length, 2);
    await one.release();
  }));

test("T-027-AC-3 (AC-168): repeated passes, a restart and a replay write no duplicate; a value added later waits for a real crossing", { skip }, () =>
  withDatabase(async ({ admin, worker, replica }) => {
    await seed(admin);
    const first = worker();
    assert.equal(await drain(admin, first), 6);
    // Repeated passes at the same watermark.

    for (let n = 0; n < 3; n += 1) assert.equal((await first.runPass()).counts.milestones_written, 0);
    await first.release();
    // A restart: a new instance takes the lease and resumes from the stored cursor.
    const second = worker();

    assert.equal((await second.runPass()).counts.milestones_written, 0);
    // A replay from the origin (an operator resets the cursor): the same rows, nothing new.
    await admin.query("DELETE FROM social_worker_state WHERE name = 'milestone-commits'");
    assert.equal(await drain(admin, second), 0);
    assert.deepEqual(await milestones(admin), AC1());
    await second.release();
    // 25 joins the config later. P1 sits at 56, already past it: its next commit (57) did not cross 25, so nothing is written.
    const third = worker([10, 25, 50, 100, 250]);
    await seedChainRead(admin, { activity: [commit(1_011, P1, 57, "57000000")] });
    await admin.query(mark(1_015));
    assert.equal(await drain(admin, third), 0);
    assert.deepEqual(await milestones(admin), AC1());
    await third.release();

    // The entries are presale posts in For You (read as the replica role).
    const entries = await forYouEntries(autocommitReader(replica, "social"), { config: SOCIAL_CONFIG_DEFAULTS, nowMs: NOW, limit: 50, hiddenKinds: [] });
    const posted = entries.filter((entry) => entry.source === "milestone").map((entry) => `${entry.entryId}|${entry.kind}|${entry.occurredAtMs}`).sort();
    assert.deepEqual(posted, AC1().map((row) => `${row.entry_id}|milestone_${row.kind}|${row.timestamp_ms}`).sort());
  }));

// --- T-029: holder milestones -------------------------------------------------

const KESTREL = `${P4}::coin::KESTREL`;
const ONDINE = `${P5}::coin::ONDINE`;
/** A coin no presale sells (the fixture's launchpad coin): never read. */
const STRANGER = "0x1::meme::MEME";

// Kestrel: 95 → 120 → 260 (100 and 250), then a drop to 90 and a rise past 100
// again (nothing new), and 600 in a checkpoint past the watermark.
const kestrel = [
  history(KESTREL, 1_001, 95), history(KESTREL, 1_002, 120), history(KESTREL, 1_003, 260),
  history(KESTREL, 1_004, 90), history(KESTREL, 1_005, 150),
];
const kestrelLate = history(KESTREL, 1_020, 600);
// Ondine's sale is not shown (blast-infra has not seen the sale coin's metadata), so it gets no post.
const ondine = [history(ONDINE, 1_002, 400)];
const stranger = [history(STRANGER, 1_002, 5_000)];

async function seedHolders(admin: Pool): Promise<void> {
  await seedChainRead(admin, {
    presales: [
      presale(P4, "Kestrel"),
      presale(P5, "Ondine", { sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null }),
    ],
    coin_holder_history: [...kestrel, kestrelLate, ...ondine, ...stranger],
  });
  await admin.query(markMarket(1_010));
  await admin.query(mark(1_010));
}

const AC1_HOLDERS = (): Milestone[] => [
  expectedHolders(P4, KESTREL, "100", kestrel[1]!),
  expectedHolders(P4, KESTREL, "250", kestrel[2]!),
].sort((a, b) => (a.entry_id < b.entry_id ? -1 : 1));

/** Passes until the holder step's cursor reaches `bound` (each pass reads at most two rows); the milestones written. */
async function drainHolders(admin: Pool, worker: SocialWorker, bound: number): Promise<number> {
  let total = 0;
  for (let index = 0; index < 50; index += 1) {

    const report = await worker.runPass();
    assert.equal(report.outcome, "ok");
    total += report.counts.milestones_written;
    const { rows } = await admin.query<{ c: string }>(
      "SELECT (value->>'c')::bigint::text AS c FROM social_worker_state WHERE name = 'milestone-holders'",
    );
    if (rows[0] && Number(rows[0].c) >= bound) return total;
  }
  throw new Error("the holder step never reached its bound");
}

test("T-029-AC-1 (AC-138): one holder milestone per value a history row reaches, with that row's time, bounded by both pipelines", { skip }, () =>
  withDatabase(async ({ admin, worker, lines }) => {
    await seedHolders(admin);
    const one = worker();
    assert.equal(await drainHolders(admin, one, 1_010), 2);
    assert.deepEqual(await milestones(admin), AC1_HOLDERS());
    // The pass metric reports the entries written.
    const passes = lines.filter((line) => line.metric === "social.worker.pass");
    assert.equal(passes.reduce((sum, line) => sum + Number(line.milestones_written), 0), 2);
    // The market pipeline reaches 1,030 but the presale pipeline has not: the batch stops at the lower
    // checkpoint, because a row there could belong to a sale that is not indexed yet.
    await admin.query(markMarket(1_030));
    assert.equal(await drainHolders(admin, one, 1_010), 0);
    assert.deepEqual(await milestones(admin), AC1_HOLDERS());
    // With both pipelines past it, the 600-holder row writes 500 at its own time.
    await admin.query(mark(1_030));
    assert.equal(await drainHolders(admin, one, 1_030), 1);
    assert.deepEqual(
      (await milestones(admin)).find((row) => row.entry_id === `m:${P4}:holders:500`),
      expectedHolders(P4, KESTREL, "500", kestrelLate),
    );
    await one.release();
  }));

test("T-029-AC-1 (AC-138): a restart, repeated passes and a replay write no duplicate, and the posts show in For You", { skip }, () =>
  withDatabase(async ({ admin, worker, replica }) => {
    await seedHolders(admin);
    const first = worker();
    assert.equal(await drainHolders(admin, first, 1_010), 2);
    // Repeated passes at the same watermark.

    for (let n = 0; n < 3; n += 1) assert.equal((await first.runPass()).counts.milestones_written, 0);
    await first.release();
    // A restart: a new instance takes the lease and resumes from the stored cursor.
    const second = worker();

    assert.equal((await second.runPass()).counts.milestones_written, 0);
    // A replay from the origin (an operator resets the cursor): the same rows, nothing new.
    await admin.query("DELETE FROM social_worker_state WHERE name = 'milestone-holders'");
    assert.equal(await drainHolders(admin, second, 1_010), 0);
    assert.deepEqual(await milestones(admin), AC1_HOLDERS());
    await second.release();
    // 150 joins the config later. Kestrel sits at 150 already, so its next row (600) did not cross 150
    // and nothing is written for it; only 500 is new.
    const third = worker(MILESTONES, [100, 150, 250, 500]);
    await admin.query(markMarket(1_030));
    await admin.query(mark(1_030));
    assert.equal(await drainHolders(admin, third, 1_030), 1);
    assert.deepEqual(
      (await milestones(admin)).map((row) => row.entry_id),
      [...AC1_HOLDERS().map((row) => row.entry_id), `m:${P4}:holders:500`].sort(),
    );
    await third.release();

    // The entries are presale posts in For You (read as the replica role).
    const entries = await forYouEntries(autocommitReader(replica, "social"), { config: SOCIAL_CONFIG_DEFAULTS, nowMs: NOW, limit: 50, hiddenKinds: [] });
    const posted = entries.filter((entry) => entry.source === "milestone").map((entry) => `${entry.entryId}|${entry.kind}|${entry.occurredAtMs}`).sort();
    assert.deepEqual(posted, [
      ...AC1_HOLDERS(), expectedHolders(P4, KESTREL, "500", kestrelLate),
    ].map((row) => `${row.entry_id}|milestone_holders|${row.timestamp_ms}`).sort());
  }));

/**
 * T-043 hidden sales: `EXCLUDED` is one of T-043's real-SUI test sales, which
 * blast-infra leaves out of every presale view (no `presales` row here) but
 * keeps in `chain_read_v1.activity`; `INCOMPLETE` is in `presales` with no
 * coin metadata, so not in `SHOWN_PRESALES`.
 */
const EXCLUDED = hex("5650e2");
const INCOMPLETE = hex("1c0e");

test("T-043 hidden sales: a hidden sale's commits write no milestone, and the shown sales' are unchanged", { skip }, () =>
  withDatabase(async ({ admin, worker }) => {
    await seed(admin);
    await seedChainRead(admin, {
      presales: [presale(INCOMPLETE, "Incomplete", { sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null, raise_target: "100000000" })],
      // Each crosses 10 and 50 backers and its target, interleaved with the shown sales' commits.
      activity: [
        commit(1_001, EXCLUDED, 9, "9000000"), commit(1_002, EXCLUDED, 60, "600000000"),
        commit(1_003, INCOMPLETE, 9, "9000000"), commit(1_006, INCOMPLETE, 60, "600000000"),
      ],
    });
    const one = worker();
    assert.equal(await drain(admin, one), 6);
    assert.deepEqual(await milestones(admin), AC1());
    await one.release();
  }));
