import { withSocialCoverage } from "../../../../test/fixtures/modules/social/worker/shared-evidence-fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { seedChainRead, type ChainPresaleRow } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { FIXTURE_NETWORK, FIXTURE_FINGERPRINT, urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { createSocialAlerts } from "#workers/modules/social/worker/alerts.ts";
import { createSocialWorker, type SocialWorker } from "../worker/runtime.ts";
import type { PortfolioFullnode } from "#workers/modules/social/portfolio/balances.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import {
  PORTFOLIO_SNAPSHOT_LATE_AFTER_MS,
  PORTFOLIO_SNAPSHOT_MAX_LAG_MS,
  PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS,
  PORTFOLIO_SNAPSHOT_STEP,
  portfolioSnapshotLate,
  portfolioSnapshotSteps,
} from "#workers/modules/social/portfolio/snapshots.ts";
import { hex, uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * OA-25 Q16 on a disposable database, as `blast_watcher` through the social
 * worker's runtime (lease, fence, one transaction per pass): the daily
 * portfolio snapshot values each account with a wallet once per UTC day,
 * exactly, in keyset batches that resume; a held coin without a fresh price
 * or wallets the fullnode does not answer for make a skipped row, retried
 * during the day and never filled with an estimate; a valued day is final;
 * the day is the chain clock's UTC day; and a late sweep raises its alert.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const POOL = { connectionTimeoutMs: 2_000, idleInTransactionMs: 10_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 2, statementTimeoutMs: 5_000 };
const MINUTE = 60_000;
const SUI = PORTFOLIO_COIN_TYPES.sui;

/** Accounts in key order: Ana holds everything, Ben an unpriced coin, Cy no wallet, Dee a wallet the fullnode fails on, Eli nothing. */
const ACCOUNTS = { ana: uuid(0xa1), ben: uuid(0xa2), cy: uuid(0xa3), dee: uuid(0xa4), eli: uuid(0xa5) } as const;
const WALLETS = { ana1: hex("a11"), ana2: hex("a12"), ben: hex("b11"), dee: hex("d11"), eli: hex("e11") } as const;
const SALES = { usdcOpen: hex("5a1e1"), suiCancelled: hex("5a1e2"), kstl: hex("5a1e3"), mrdn: hex("5a1e4") } as const;
const KSTL = `${SALES.kstl}::coin::KSTL`;
const MRDN = `${SALES.mrdn}::coin::MRDN`;
/** 2026-10-06 00:00:00 UTC. */
const DAY0 = Date.UTC(2026, 9, 6);

function holderId(label: string): string {
  const digest = createHash("sha256").update(label).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function sale(presale_id: string, over: Partial<ChainPresaleRow>): ChainPresaleRow {
  return {
    presale_id, sale_token: `${presale_id}::coin::X`, quote_type: USDC_COIN_TYPE, sale_symbol: "X", sale_name: "X", sale_icon_url: "https://i/x.png",
    sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle: "open", start_ms: DAY0 - 10 * 86_400_000, end_ms: DAY0 + 10 * 86_400_000,
    raise_target: "1000000000000", min_commitment: "1000000", wallet_cap: null, total_commitments: "0", participants: 0, venue: "cetus",
    pool_id: null, updated_checkpoint: 1, ...over,
  };
}

/** The fullnode: balances by `owner|coin`; owners in `failing` throw. */
class StubFullnode implements PortfolioFullnode {
  readonly calls: string[] = [];
  beforeRead?: () => Promise<void>;
  failing = new Set<string>([WALLETS.dee]);
  balances: Record<string, string> = {
    [`${WALLETS.ana1}|${SUI}`]: "1500000000",
    [`${WALLETS.ana2}|${SUI}`]: "2000000000",
    [`${WALLETS.ana1}|${USDC_COIN_TYPE}`]: "10000000",
  };
  async getBalance({ owner, coinType }: Readonly<{ owner: string; coinType: string }>) {
    const beforeRead = this.beforeRead;
    this.beforeRead = undefined;
    if (beforeRead) await beforeRead();
    this.calls.push(owner);
    if (this.failing.has(owner)) throw new Error("fullnode down");
    return { balance: { balance: this.balances[`${owner}|${coinType}`] ?? "0" } };
  }
}

type Snapshot = Readonly<{
  account_id: string;
  day: string;
  value_usd: string | null;
  committed_usd: string | null;
  claimable_usd: string | null;
  tokens_usd: string | null;
  usdc_usd: string | null;
  sui_usd: string | null;
  skipped: string | null;
  taken_at_ms: string;
  checkpoint: string;
  prices_as_of_ms: string | null;
}>;

type Harness = Readonly<{
  /** Superuser URL of the test's own database. */
  url: string;
  admin: Pool;
  watcher: Pool;
  fullnode: StubFullnode;
  /** Both pipelines' watermark at `ms` (checkpoint `checkpoint`), and the process clock `lagMs` later. */
  clock(ms: number, options?: Readonly<{ checkpoint?: number; lagMs?: number; presaleBehindMs?: number }>): Promise<void>;
  worker(batchSize?: number): SocialWorker;
  pass(worker: SocialWorker): Promise<Readonly<{ written: number; skipped: number }>>;
  rows(): Promise<Snapshot[]>;
  lines: Array<Record<string, unknown>>;
}>;

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 3 });
  const watcher = createRuntimePool(urlAs(database.url, "blast_watcher"), POOL, "portfolio-snapshot-test");
  const workers: SocialWorker[] = [];
  try {
    for (const [name, id] of Object.entries(ACCOUNTS)) {
      await admin.query("INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES ($1, $2, $3)", [id, `did:privy:snap-${name}`, `snap_${name}`]);
    }
    for (const [address, account] of [[WALLETS.ana1, ACCOUNTS.ana], [WALLETS.ana2, ACCOUNTS.ana], [WALLETS.ben, ACCOUNTS.ben], [WALLETS.dee, ACCOUNTS.dee], [WALLETS.eli, ACCOUNTS.eli]]) {
      await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, now() - interval '30 days')", [address, account]);
    }
    await seedChainRead(admin, {
      presales: [
        sale(SALES.usdcOpen, {}),
        sale(SALES.suiCancelled, { quote_type: SUI, quote_symbol: "SUI", quote_decimals: 9, lifecycle: "cancelled", end_ms: DAY0 - 86_400_000 }),
        sale(SALES.kstl, { sale_token: KSTL, sale_symbol: "KSTL", lifecycle: "migrated", end_ms: DAY0 - 86_400_000 }),
        sale(SALES.mrdn, { sale_token: MRDN, sale_symbol: "MRDN", lifecycle: "migrated", end_ms: DAY0 - 86_400_000 }),
      ],
      presale_positions: [
        // Ana: 100 USDC in an open sale; 2 SUI in a cancelled one (claimable); her KSTL claim is delivered (its tokens are held).
        { presale_id: SALES.usdcOpen, wallet: WALLETS.ana1, commitment: "100000000", last_commit_ms: DAY0 - 3_600_000, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null },
        { presale_id: SALES.suiCancelled, wallet: WALLETS.ana2, commitment: "2000000000", last_commit_ms: DAY0 - 3 * 86_400_000, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null, claimable_tokens: "0", claimable_quote_refund: "2000000000" },
        { presale_id: SALES.kstl, wallet: WALLETS.ana1, commitment: "300000000", last_commit_ms: DAY0 - 5 * 86_400_000, claim_digest: "Claim1".padEnd(44, "1"), claimed_tokens: "400000000000000", claimed_quote_refund: "0", claimed_ms: DAY0 - 2 * 86_400_000 },
      ],
      coin_balances: [
        // 600,000 KSTL over Ana's two wallets; Ben holds MRDN, which has no price.
        { coin_type: KSTL, owner: WALLETS.ana1, balance: "400000000000000", updated_checkpoint: 1 },
        { coin_type: KSTL, owner: WALLETS.ana2, balance: "200000000000000", updated_checkpoint: 1 },
        { coin_type: MRDN, owner: WALLETS.ben, balance: "5000000000", updated_checkpoint: 1 },
      ],
    });
    await admin.query("INSERT INTO blast_infra_fixture.wallet_sync(owner,timestamp_ms) SELECT address,$1 FROM social_account_wallets", [DAY0]);
    const fullnode = new StubFullnode();
    let processNow = DAY0;
    const lines: Array<Record<string, unknown>> = [];
    const log = (metric: string, fields: Record<string, unknown> = {}) => void lines.push({ metric, ...fields });
    const harness: Harness = {
      url: database.url,
      admin,
      watcher,
      fullnode,
      lines,
      async clock(ms, options = {}) {
        await admin.query(
          `UPDATE watermarks SET checkpoint_hi_inclusive = $1,
             timestamp_ms_hi_inclusive = CASE pipeline WHEN 'presale' THEN $2::bigint - $3::bigint ELSE $2::bigint END`,
          [options.checkpoint ?? 5_000, ms, options.presaleBehindMs ?? 0],
        );
        // Prices as blast-infra keeps them: SUI and KSTL fresh at the chain clock.
        await admin.query("DELETE FROM blast_infra_fixture.prices WHERE coin_type = ANY($1::text[])", [[SUI, KSTL]]);
        await seedChainRead(admin, {
          prices: [
            { coin_type: SUI, usd_price: "3.5", as_of_ms: ms - 1_000, source: "pyth" },
            { coin_type: KSTL, usd_price: "0.0021", as_of_ms: ms - 2_000, source: "pool" },
          ],
        });
        processNow = ms + (options.lagMs ?? 500);
      },
      worker(batchSize = 2) {
        const created = withSocialCoverage(createSocialWorker({
        selection: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT },
          pool: watcher,
          steps: portfolioSnapshotSteps({ batchSize, retentionDays: 400, fullnode: () => fullnode }),
          config: { intervalMs: 50, maxBackoffMs: 400, leaseTtlMs: 5_000 },
          holder: holderId(`snapshot-${workers.length}`),
          log,
          now: () => processNow,
          alerts: createSocialAlerts({ webhookUrl: null, log, now: () => processNow }),
        }), admin);
        workers.push(created);
        return created;
      },
      async pass(worker) {

        const report = await worker.runPass();
        assert.equal(report.outcome, "ok", JSON.stringify(lines.filter((line) => line.metric === "social.worker.step_error")));
        return { written: report.counts.snapshots_written, skipped: report.counts.snapshots_skipped };
      },
      async rows() {
        return (await admin.query<Snapshot>(
          `SELECT account_id::text, day::text, value_usd::text, committed_usd::text, claimable_usd::text, tokens_usd::text, usdc_usd::text,
             sui_usd::text, skipped, taken_at_ms::text, checkpoint::text, prices_as_of_ms::text
           FROM social_portfolio_snapshots ORDER BY day, account_id`,
        )).rows;
      },
    };
    await run(harness);
  } finally {
    for (const worker of workers) await worker.release().catch(() => undefined);
    await watcher.end();
    await admin.end();
    await database.drop();
  }
}

const ANA_VALUED = {
  value_usd: "1389.25",
  // 100 USDC committed to an open sale, at face value.
  committed_usd: "100.00",
  // 2 SUI in a cancelled sale × $3.50.
  claimable_usd: "7.00",
  // 600,000 KSTL × $0.0021.
  tokens_usd: "1260.00",
  usdc_usd: "10.00",
  // 3.5 SUI over two wallets × $3.50.
  sui_usd: "12.25",
  skipped: null,
};

test("OA-25 Q16: once per UTC day each account with a wallet is valued exactly, in keyset batches that resume; re-runs write nothing", { skip }, () =>
  withHarness(async ({ admin, fullnode, clock, worker, pass, rows }) => {
    const T = DAY0 + 5 * MINUTE;
    await clock(T, { checkpoint: 7_000 });
    const one = worker(2);
    // Five accounts, two a pass: Ana and Ben, then Cy (no wallet: nothing) and Dee, then Eli, then the sweep ends.
    assert.deepEqual(await pass(one), { written: 1, skipped: 1 });
    // A restart resumes from the stored cursor: a new worker (and a new step instance) picks up after Ben.
    await one.release();
    const two = worker(2);
    assert.deepEqual(await pass(two), { written: 0, skipped: 1 });
    assert.deepEqual(await pass(two), { written: 1, skipped: 0 });
    assert.deepEqual(await pass(two), { written: 0, skipped: 0 });
    const cursor = (await admin.query("SELECT value FROM social_worker_state WHERE name = $1", [PORTFOLIO_SNAPSHOT_STEP])).rows[0]?.value;
    assert.deepEqual(cursor, { day: "2026-10-06", after: ACCOUNTS.eli, swept_ms: T, retry_after: null, retry_at_ms: T + PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS });
    const snapshots = await rows();
    assert.deepEqual(snapshots.map((row) => [row.account_id, row.skipped]), [
      [ACCOUNTS.ana, null], [ACCOUNTS.ben, "price_missing"], [ACCOUNTS.dee, "balances_unavailable"], [ACCOUNTS.eli, null],
    ]);
    const ana = snapshots[0]!;
    assert.deepEqual(
      { ...ana, taken_at_ms: Number(ana.taken_at_ms), checkpoint: Number(ana.checkpoint), prices_as_of_ms: Number(ana.prices_as_of_ms) },
      { account_id: ACCOUNTS.ana, day: "2026-10-06", ...ANA_VALUED, taken_at_ms: T, checkpoint: 7_000, prices_as_of_ms: T - 2_000 },
    );
    // Nothing held is a real zero; a skipped day holds no figure at all.
    assert.deepEqual([snapshots[3]!.value_usd, snapshots[3]!.prices_as_of_ms], ["0.00", null]);
    for (const row of snapshots.slice(1, 3)) {
      assert.deepEqual([row.value_usd, row.committed_usd, row.claimable_usd, row.tokens_usd, row.usdc_usd, row.sui_usd, row.prices_as_of_ms], [null, null, null, null, null, null, null]);
    }
    // Idempotent: more passes before the retry is due, a cursor deleted (the sweep restarts) and a second worker write nothing.
    const callsBefore = fullnode.calls.length;
    assert.deepEqual(await pass(two), { written: 0, skipped: 0 });
    await admin.query("DELETE FROM social_worker_state WHERE name = $1", [PORTFOLIO_SNAPSHOT_STEP]);
    for (let n = 0; n < 4; n += 1) assert.deepEqual(await pass(two), { written: 0, skipped: 0 });
    // The restarted sweep skips every account that has its day: no fullnode call, no row rewritten.
    assert.equal(fullnode.calls.length, callsBefore);
    assert.deepEqual(await rows(), snapshots);
  }));

test("OA-25 Q16: a skipped day is retried every 15 minutes until the day ends; a valued day never changes", { skip }, () =>
  withHarness(async ({ admin, fullnode, clock, worker, pass, rows }) => {
    const T = DAY0 + 5 * MINUTE;
    await clock(T);
    const w = worker(10);
    assert.deepEqual(await pass(w), { written: 2, skipped: 2 });
    assert.deepEqual(await pass(w), { written: 0, skipped: 0 });
    const first = await rows();
    // MRDN gets a price and the fullnode answers for Dee, but the retry is not due yet: nothing moves.
    await clock(T + PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS - 1);
    await seedChainRead(admin, { prices: [{ coin_type: MRDN, usd_price: "0.5", as_of_ms: T + PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS - 5_000, source: "pool" }] });
    fullnode.failing.clear();
    assert.deepEqual(await pass(w), { written: 0, skipped: 0 });
    // Due: Ben (5 MRDN × $0.50) and Dee (nothing held) are valued at the retry's moment; Ana's row is untouched.
    const R = T + PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS;
    await clock(R, { checkpoint: 7_100 });
    assert.deepEqual(await pass(w), { written: 2, skipped: 0 });
    assert.deepEqual(await pass(w), { written: 0, skipped: 0 });
    const after = await rows();
    assert.deepEqual(after[0], first[0]);
    assert.deepEqual([after[1]!.value_usd, after[1]!.tokens_usd, after[1]!.skipped, Number(after[1]!.taken_at_ms), after[1]!.checkpoint], ["2.50", "2.50", null, R, "7100"]);
    assert.deepEqual([after[2]!.value_usd, after[2]!.skipped], ["0.00", null]);
    // 0097's trigger: a valued day is a fact, for every role.
    await assert.rejects(admin.query("UPDATE social_portfolio_snapshots SET value_usd = 1, committed_usd = 1, claimable_usd = 0, tokens_usd = 0, usdc_usd = 0, sui_usd = 0 WHERE account_id = $1", [ACCOUNTS.ana]), {
      code: "23514",
      constraint: "social_portfolio_snapshots_valued_final",
    });
    // A skipped day cannot carry a figure, and a valued one must add up.
    await assert.rejects(
      admin.query(
        `INSERT INTO social_portfolio_snapshots (account_id, day, value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd, skipped, taken_at_ms, checkpoint)
         VALUES ($1, '2026-10-01', 1.00, 0, 0, 0, 0, 0, NULL, $2, 1)`,
        [ACCOUNTS.cy, Date.UTC(2026, 9, 1, 12)],
      ),
      { code: "23514", constraint: "social_portfolio_snapshots_valued" },
    );
    // The day is the UTC day of the time it was taken.
    await assert.rejects(
      admin.query(
        `INSERT INTO social_portfolio_snapshots (account_id, day, skipped, taken_at_ms, checkpoint) VALUES ($1, '2026-10-01', 'price_missing', $2, 1)`,
        [ACCOUNTS.cy, Date.UTC(2026, 9, 2)],
      ),
      { code: "23514", constraint: "social_portfolio_snapshots_day" },
    );
  }));

test("OA-25 Q16: the day is the chain clock's UTC day; 23:59:59.999 and 00:00:00.000 are two days; a lagging indexer is waited for", { skip }, () =>
  withHarness(async ({ admin, clock, worker, pass, rows }) => {
    const w = worker(10);
    // The indexer is 6 minutes behind the process clock: the step waits rather than mixing old holdings with today's cash.
    await clock(DAY0 - 1, { lagMs: PORTFOLIO_SNAPSHOT_MAX_LAG_MS + MINUTE });
    assert.deepEqual(await pass(w), { written: 0, skipped: 0 });
    assert.deepEqual(await rows(), []);
    // The presale pipeline sets the clock when it is the slower one: its time, 2 s before midnight.
    await clock(DAY0 + 1_000, { presaleBehindMs: 3_000 });
    assert.deepEqual(await pass(w), { written: 2, skipped: 2 });
    assert.deepEqual([...new Set((await rows()).map((row) => [row.day, row.taken_at_ms].join(" ")))], [`2026-10-05 ${DAY0 - 2_000}`]);
    // 23:59:59.999 is still the 5th: nothing new.
    await clock(DAY0 - 1);
    assert.deepEqual(await pass(w), { written: 0, skipped: 0 });
    // 00:00:00.000 starts the 6th: a new sweep, a new row per account, the 5th's kept.
    await clock(DAY0);
    assert.deepEqual(await pass(w), { written: 2, skipped: 2 });
    const byDay = (await rows()).reduce<Record<string, number>>((count, row) => ({ ...count, [row.day]: (count[row.day] ?? 0) + 1 }), {});
    assert.deepEqual(byDay, { "2026-10-05": 4, "2026-10-06": 4 });
    const ana6 = (await rows()).find((row) => row.day === "2026-10-06" && row.account_id === ACCOUNTS.ana)!;
    assert.deepEqual([ana6.value_usd, Number(ana6.taken_at_ms)], [ANA_VALUED.value_usd, DAY0]);
    // A stale price (16 minutes old at the chain clock) skips the day; nothing is estimated from it.
    await clock(DAY0 + 86_400_000);
    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1 WHERE coin_type = $2", [DAY0 + 86_400_000 - 16 * MINUTE, SUI]);
    assert.deepEqual(await pass(w), { written: 1, skipped: 3 });
    const ana7 = (await rows()).find((row) => row.day === "2026-10-07" && row.account_id === ACCOUNTS.ana)!;
    assert.deepEqual([ana7.value_usd, ana7.skipped], [null, "price_missing"]);
  }));

test("OA-25 Q16: an account's snapshots older than the retention go as it gets its new day", { skip }, () =>
  withHarness(async ({ admin, clock, worker, pass }) => {
    const old = (daysAgo: number) =>
      admin.query(
        `INSERT INTO social_portfolio_snapshots (account_id, day, value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd, taken_at_ms, checkpoint)
         VALUES ($1, $2::date, 5.00, 5.00, 0, 0, 0, 0, $3, 1)`,
        [ACCOUNTS.eli, new Date(DAY0 - daysAgo * 86_400_000).toISOString().slice(0, 10), DAY0 - daysAgo * 86_400_000 + 1_000],
      );
    // Retention 400 days: today and the 399 before it are kept.
    await old(400);
    await old(399);
    await old(1);
    await clock(DAY0 + MINUTE);
    await pass(worker(10));
    const days = (await admin.query<{ day: string }>("SELECT day::text FROM social_portfolio_snapshots WHERE account_id = $1 ORDER BY day", [ACCOUNTS.eli])).rows.map((row) => row.day);
    assert.deepEqual(days, ["2025-09-02", "2026-10-05", "2026-10-06"]);
  }));

test("OA-25 Q16: a sweep not finished three hours into the UTC day raises step_late:portfolio-snapshot, and it clears", { skip }, () =>
  withHarness(async ({ admin, clock, worker, pass, lines }) => {
    const watcherDb = autocommitReader(admin, "social");
    // Before 03:00 nothing is late, however far the sweep is.
    assert.equal(await portfolioSnapshotLate(watcherDb, DAY0 + PORTFOLIO_SNAPSHOT_LATE_AFTER_MS - 1), null);
    assert.deepEqual(await portfolioSnapshotLate(watcherDb, DAY0 + PORTFOLIO_SNAPSHOT_LATE_AFTER_MS), { day: "2026-10-06", sweeping: null, swept: false });
    // Through the runtime: the minute check raises it while the sweep is behind (the indexer lagging stalls it here).
    const w = worker(2);
    await clock(DAY0 + PORTFOLIO_SNAPSHOT_LATE_AFTER_MS, { lagMs: PORTFOLIO_SNAPSHOT_MAX_LAG_MS + MINUTE });
    await pass(w);
    assert.ok(lines.some((line) => line.metric === "social.alert" && line.key === "step_late:portfolio-snapshot" && line.outcome === "logged"));
    // The sweep finishes: the next check clears it.
    const w2 = worker(10);
    await w.release();
    await clock(DAY0 + PORTFOLIO_SNAPSHOT_LATE_AFTER_MS + MINUTE);
    await pass(w2);
    await pass(w2);
    assert.equal(await portfolioSnapshotLate(watcherDb, DAY0 + PORTFOLIO_SNAPSHOT_LATE_AFTER_MS + 2 * MINUTE), null);
  }));


test("remaining claims are valued after another wallet has claimed, including the token price", { skip }, () =>
  withHarness(async ({ admin, clock, worker, pass, rows }) => {
    const claimSale = hex("5a1e5");
    const claimToken = `${claimSale}::coin::CLAIM`;
    await seedChainRead(admin, {
      presales: [sale(claimSale, { sale_token: claimToken, lifecycle: "migrated", end_ms: DAY0 - 86_400_000 })],
      presale_positions: [{
        presale_id: claimSale, wallet: WALLETS.ana1, commitment: "300000000", last_commit_ms: DAY0 - 86_400_000,
        claim_digest: "AlreadyClaimed", claimed_tokens: "300000000000", claimed_quote_refund: "0", claimed_ms: DAY0,
        claimable_tokens: "0", claimable_quote_refund: "0",
      }, {
        presale_id: claimSale, wallet: WALLETS.ana2, commitment: "100000000", last_commit_ms: DAY0 - 86_400_000,
        claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null,
        claimable_tokens: "100000000000", claimable_quote_refund: "5000000",
      }],
      // No wallet holds this coin: the claim itself must request its price.
      prices: [{ coin_type: claimToken, usd_price: "0.0021", as_of_ms: DAY0, source: "pool" }],
    });
    await clock(DAY0 + MINUTE);
    await pass(worker());
    const ana = (await rows()).find((row) => row.account_id === ACCOUNTS.ana)!;
    assert.equal(ana.claimable_usd, "12.21"); // 2 SUI refund + 100 CLAIM + 5 USDC refund.
    assert.equal(ana.tokens_usd, "1260.00");
    assert.equal(ana.value_usd, "1394.46");
  }),
);

test("a missing remaining-claim amount skips the snapshot, without recording the original commitment", { skip }, () =>
  withHarness(async ({ clock, worker, pass, rows, admin }) => {
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_quote_refund = NULL WHERE presale_id = $1", [SALES.suiCancelled]);
    await clock(DAY0 + MINUTE);
    await pass(worker());
    const ana = (await rows()).find((row) => row.account_id === ACCOUNTS.ana)!;
    assert.equal(ana.skipped, "balances_unavailable");
    assert.equal(ana.value_usd, null);
  }),
);


test("shared portfolio: provider phase releases primary connections; observations retain exact source/time and replay is immutable", { skip }, () =>
  withHarness(async ({ admin, watcher, fullnode, clock, worker, pass, rows }) => {
    const T = DAY0 + MINUTE;
    await clock(T);
    fullnode.beforeRead = async () => {
      const active = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='portfolio-snapshot-test' AND state='idle in transaction'");
      assert.equal(active.rows[0]?.n, 0);
      await watcher.query("SELECT 1");
    };
    const w = worker(10);
    assert.deepEqual(await pass(w), { written: 2, skipped: 2 });
    const observations = (await admin.query("SELECT account_id::text, source, observed_at_ms::text, sui_atoms::text, usdc_atoms::text FROM social_portfolio_balance_observations ORDER BY account_id")).rows;
    assert.deepEqual(observations, [
      { account_id: ACCOUNTS.ana, source: "bounded_fullnode", observed_at_ms: String(T + 500), sui_atoms: "3500000000", usdc_atoms: "10000000" },
      { account_id: ACCOUNTS.ben, source: "bounded_fullnode", observed_at_ms: String(T + 500), sui_atoms: "0", usdc_atoms: "0" },
      { account_id: ACCOUNTS.eli, source: "bounded_fullnode", observed_at_ms: String(T + 500), sui_atoms: "0", usdc_atoms: "0" },
    ]);
    assert.equal((await rows()).find((row) => row.account_id === ACCOUNTS.dee)?.skipped, "balances_unavailable");
    await admin.query("DELETE FROM social_worker_state WHERE name=$1", [PORTFOLIO_SNAPSHOT_STEP]);
    await pass(w);
    assert.deepEqual((await admin.query("SELECT account_id::text, source, observed_at_ms::text, sui_atoms::text, usdc_atoms::text FROM social_portfolio_balance_observations ORDER BY account_id")).rows, observations);
  }));

test("shared portfolio: account privacy, wallet ownership and preferences changing during provider reads discard output and cursor", { skip }, () =>
  withHarness(async ({ admin, fullnode, clock, worker, pass, rows }) => {
    await clock(DAY0 + MINUTE);
    const w = worker(10);
    const mutations = [
      () => admin.query("UPDATE social_accounts SET portfolio_public=true WHERE account_id=$1", [ACCOUNTS.ana]),
      () => admin.query("UPDATE social_account_wallets SET account_id=$1 WHERE address=$2", [ACCOUNTS.eli, WALLETS.ana1]),
      () => admin.query("INSERT INTO social_notification_preferences(account_id, unlocks) VALUES($1,false)", [ACCOUNTS.ana]),
    ];
    for (const mutate of mutations) {
      fullnode.beforeRead = async () => { await mutate(); };
      assert.deepEqual(await pass(w), { written: 0, skipped: 0 });
      assert.deepEqual(await rows(), []);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_portfolio_balance_observations")).rows[0]?.n, 0);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_worker_state WHERE name=$1", [PORTFOLIO_SNAPSHOT_STEP])).rows[0]?.n, 0);
    }
    assert.deepEqual(await pass(w), { written: 2, skipped: 2 });
  }));

test("shared portfolio: an observation SQL failure rolls back snapshots, observation and cursor together; retry completes once", { skip }, () =>
  withHarness(async ({ admin, clock, worker, pass, rows }) => {
    await clock(DAY0 + MINUTE);
    await admin.query("CREATE FUNCTION fail_social_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture write failure'; END; $$");
    await admin.query("CREATE TRIGGER fail_social_observation BEFORE INSERT ON social_portfolio_balance_observations FOR EACH ROW EXECUTE FUNCTION fail_social_observation()");
    const w = worker(10);
    assert.equal((await w.runPass()).outcome, "error");
    assert.deepEqual(await rows(), []);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_portfolio_balance_observations")).rows[0]?.n, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_worker_state WHERE name=$1", [PORTFOLIO_SNAPSHOT_STEP])).rows[0]?.n, 0);
    await admin.query("DROP TRIGGER fail_social_observation ON social_portfolio_balance_observations");
    assert.deepEqual(await pass(w), { written: 2, skipped: 2 });
  }));

test("shared portfolio: waiting owner guard rejects a stale RR snapshot after privacy and wallet insertion commit", { skip }, () =>
  withHarness(async ({ url, admin, watcher }) => {
    for (const change of [
      "UPDATE social_accounts SET portfolio_public=true WHERE account_id='" + ACCOUNTS.ana + "'",
      "INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES('" + hex("a13") + "','" + ACCOUNTS.ana + "',now())",
    ]) {
      const writer = await admin.connect();
      const reader = await watcher.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(change);
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await reader.query("SELECT account_id FROM social_accounts LIMIT 1");
        const waiting = reader.query("SELECT public.social_lock_portfolio_sources()");
        const rejected = assert.rejects(waiting, { code: "40001" });
        let blocked = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const result = await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name='portfolio-snapshot-test' AND wait_event_type='Lock'");
          if (result.rows[0]?.n > 0) { blocked = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(blocked, true, "the guard must actually wait on a canonical source writer");
        await writer.query("COMMIT");
        await rejected;
        await reader.query("ROLLBACK");
        await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
        await reader.query("SELECT public.social_lock_portfolio_sources()");
        await reader.query("COMMIT");
      } finally {
        await writer.query("ROLLBACK");
        await reader.query("ROLLBACK");
        writer.release(); reader.release();
      }
    }
    await assert.rejects(watcher.query("UPDATE social_portfolio_source_revision SET revision=revision+1"), { code: "42501" });
    const social = createRuntimePool(urlAs(url, "blast_social"), POOL, "portfolio-guard-denied");
    try { await assert.rejects(social.query("SELECT public.social_lock_portfolio_sources()"), { code: "42501" }); }
    finally { await social.end(); }
  }));

test("shared portfolio: lost lease and a chain day advancing during cash reads discard prepared results", { skip }, () =>
  withHarness(async ({ admin, fullnode, clock, worker, pass, rows }) => {
    await clock(DAY0 + MINUTE);
    const w = worker(10);
    let changed: number | null = null;
    let mutationError: unknown;
    fullnode.beforeRead = async () => {
      try { changed = (await admin.query("UPDATE mission_control_worker_leases SET acquired_at=now()-interval '2 seconds', expires_at=now()-interval '1 second' WHERE job='social-worker'")).rowCount; }
      catch (error) { mutationError = error; }
    };
    const lost = await w.runPass();
    assert.equal(mutationError, undefined);
    assert.equal(changed, 1, "the provider phase must actually expire the held lease");
    assert.equal(lost.outcome, "error");
    assert.deepEqual(await rows(), []);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_worker_state WHERE name=$1", [PORTFOLIO_SNAPSHOT_STEP])).rows[0]?.n, 0);
    fullnode.beforeRead = async () => { await clock(DAY0 + 86_400_000 + MINUTE); };
    assert.deepEqual(await pass(w), { written: 0, skipped: 0 });
    assert.deepEqual(await rows(), []);
    assert.deepEqual(await pass(w), { written: 2, skipped: 2 });
    assert.deepEqual([...new Set((await rows()).map((row) => row.day))], ["2026-10-07"]);
  }));


test("shared portfolio: a skipped retry with unavailable cash removes the prior attempt's observation and keeps figures empty", { skip }, () =>
  withHarness(async ({ admin, fullnode, clock, worker, pass, rows }) => {
    const T = DAY0 + MINUTE;
    await clock(T);
    const w = worker(10);
    await pass(w);
    await pass(w);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_portfolio_balance_observations WHERE account_id=$1", [ACCOUNTS.ben])).rows[0]?.n, 1);
    fullnode.failing.add(WALLETS.ben);
    await clock(T + PORTFOLIO_SNAPSHOT_RETRY_EVERY_MS);
    assert.deepEqual(await pass(w), { written: 0, skipped: 2 });
    assert.equal((await rows()).find((row) => row.account_id === ACCOUNTS.ben)?.skipped, "balances_unavailable");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_portfolio_balance_observations WHERE account_id=$1", [ACCOUNTS.ben])).rows[0]?.n, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_portfolio_balance_observations WHERE account_id=$1", [ACCOUNTS.ana])).rows[0]?.n, 1);
  }));
