import { withSocialCoverage } from "../../../../test/fixtures/modules/social/worker/shared-evidence-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { Pool, QueryResultRow } from "pg";

import { seedChainRead, type ChainActivityRow } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { FIXTURE_NETWORK, FIXTURE_FINGERPRINT, advanceWatermark, urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { activityEntryId } from "@blast/core/modules/social/contracts/feed-entries.ts";
import {
  FEED_STORY_ACCOUNTS,
  FEED_STORY_HIDDEN,
  FEED_STORY_PRESALES,
  FEED_STORY_QUOTE_TYPE,
  FEED_STORY_WALLETS,
  seedFeedStory,
  type FeedStory,
} from "../../../../../../packages/core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialAlerts } from "#workers/modules/social/worker/alerts.ts";
import { createSocialWorker, type SocialWorker } from "../worker/runtime.ts";
import { INTENT_STATEMENTS, intentSteps } from "#workers/modules/social/intents/resolve.ts";
import type { SocialWorkerStep } from "#workers/modules/social/worker/steps.ts";

/**
 * Social feed T-026 (AC-081, AC-097 to AC-101, AC-103, AC-139, AC-169,
 * AC-099, AC-130) on a disposable database: the intent step on the social
 * worker runtime as `blast_watcher`, over the fixture `chain_read_v1` views
 * and the feed story's accounts, wallets and posts.
 *
 * Intents are inserted directly here. The route that writes them has its own
 * suite (`intents.integration.test.ts`); this one is about what the worker
 * makes of a row once the indexer shows its transaction.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 2, statementTimeoutMs: 10_000 };
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const A = FEED_STORY_ACCOUNTS;
const W = FEED_STORY_WALLETS;
const P = FEED_STORY_PRESALES;

/** An account whose wallet was linked a minute ago: anything older is not its own. */
const NEWCOMER = "00000000-0000-4000-8000-000000000911";
const NEWCOMER_WALLET = `0x${"91".repeat(32)}`;

let slot = 100;
/** One activity row the worker can resolve an intent against. */
function activity(fields: Partial<ChainActivityRow> & Pick<ChainActivityRow, "digest" | "actor">): ChainActivityRow {
  slot += 1;
  return {
    checkpoint: 31_000, tx_slot: slot, event_slot: 0, part: 0, timestamp_ms: NOW - 5 * MINUTE,
    kind: "presale_commit", product: "presale", tx_sender: fields.actor, presale_id: P.open,
    coin_type: `${P.open}::coin::X`, quote_type: FEED_STORY_QUOTE_TYPE, quote_amount: "50000000",
    coin_amount: null, quote_refund: null, usd_value: "50", usd_price_as_of_ms: NOW - 5 * MINUTE,
    venue: null, participants_after: null, total_commitments_after: null,
    ...fields,
  };
}

const activityIdOf = (row: ChainActivityRow) => `${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`;
const entryOf = (row: ChainActivityRow) => activityEntryId(activityIdOf(row));

type IntentRow = Readonly<{ tx_digest: string; status: string; resolved_at: string | null }>;
type AttributionRow = Readonly<{
  tx_digest: string;
  entry_id: string;
  author_account_id: string | null;
  actor_account_id: string;
  action: string;
  presale_id: string;
  quote_amount: string;
  usd_value: string | null;
  occurred_at_ms: string;
}>;
type WhyRow = Readonly<{ entry_id: string; author_account_id: string; text: string; state: string; presale_id: string | null }>;

type Fixture = Readonly<{
  admin: Pool;
  story: FeedStory;
  worker: (now?: () => number, steps?: readonly SocialWorkerStep[]) => SocialWorker;
  lines: Array<Record<string, unknown>>;
  /** Inserts one pending intent as the route would have. */
  intent(input: Readonly<{
    digest: string;
    account: string;
    action?: "commit" | "buy" | "sell";
    presale?: string;
    source?: string | null;
    why?: string | null;
    registeredMs?: number;
  }>): Promise<void>;
  statuses(): Promise<IntentRow[]>;
  attributions(): Promise<AttributionRow[]>;
  whys(): Promise<WhyRow[]>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const watcher = createRuntimePool(urlAs(database.url, "blast_watcher"), POOL, "intents-watcher-test");
  const lines: Array<Record<string, unknown>> = [];
  try {
    const story = await seedFeedStory(admin, { nowMs: NOW });
    // An account that linked its wallet a minute ago: AC-098's second half.
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, privacy, sharing_since, onboarded_at)
       VALUES ($1, 'did:privy:newcomer', 'newcomer', 'New', 'x-newcomer', 'newcomer_x', 'public', $2, $2)`,
      [NEWCOMER, new Date(NOW - 60 * DAY).toISOString()],
    );
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [
      NEWCOMER_WALLET,
      NEWCOMER,
      new Date(NOW - MINUTE).toISOString(),
    ]);
    const log = (metric: string, fields: Record<string, unknown> = {}) => void lines.push({ metric, ...fields });
    let holder = 0;
    const worker = (now?: () => number, steps?: readonly SocialWorkerStep[]) => {
      holder += 1;
      return withSocialCoverage(createSocialWorker({
        selection: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT },
        pool: watcher,
        steps: steps ?? intentSteps({ batchSize: 50 }, { createId: () => `00000000-0000-4000-8000-${(holder * 1_000 + slot).toString(16).padStart(12, "0")}` }),
        config: { intervalMs: 50, maxBackoffMs: 400, leaseTtlMs: 5_000 },
        holder: `00000000-0000-4000-8000-${holder.toString(16).padStart(12, "0")}`,
        log,
        ...(now ? { now } : {}),
        alerts: createSocialAlerts({ webhookUrl: null, log }),
      }), admin);
    };
    await run({
      admin,
      story,
      worker,
      lines,
      intent: async ({ digest, account, action = "commit", presale = P.open, source = null, why = null, registeredMs = NOW - 5 * MINUTE - 1_000 }) => {
        await admin.query(
          `INSERT INTO social_intents (tx_digest, account_id, action, presale_id, source_entry_id, why_text, registered_at)
           VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::numeric / 1000))`,
          [digest, account, action, presale, source, why, registeredMs],
        );
      },
      statuses: async () => {
        const { rows } = await admin.query<IntentRow>("SELECT tx_digest, status, resolved_at::text FROM social_intents ORDER BY tx_digest COLLATE \"C\"");
        return rows;
      },
      attributions: async () => {
        const { rows } = await admin.query<AttributionRow>(
          `SELECT tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id,
             quote_amount::text, usd_value::text, occurred_at_ms::text
           FROM social_attributions WHERE tx_digest NOT LIKE 'FsAttr%' ORDER BY tx_digest COLLATE "C"`,
        );
        return rows;
      },
      whys: async () => {
        const { rows } = await admin.query<WhyRow>(
          "SELECT entry_id, author_account_id, text, state, presale_id FROM social_whys WHERE entry_id LIKE 'a:31000:%' ORDER BY entry_id COLLATE \"C\"",
        );
        return rows;
      },
    });
  } finally {
    await watcher.end();
    await admin.end();
    await database.drop();
  }
}

/** One pass of both steps; the counts it reported. */
async function pass(worker: SocialWorker): Promise<Readonly<{ resolved: number; rejected: number; late: number }>> {

  const report = await worker.runPass();
  assert.equal(report.outcome, "ok");
  return { resolved: report.counts.intents_resolved, rejected: report.counts.intents_rejected, late: report.counts.intents_late };
}

test("T-026-AC-3 (AC-100, AC-103): a commit through someone's post, a lifecycle post and a milestone post each credit it", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, worker }) => {
    const through = activity({ digest: "InThrough".padEnd(44, "1"), actor: W.nova });
    const lifecycle = activity({ digest: "InLife".padEnd(44, "1"), actor: W.nova });
    const milestone = activity({ digest: "InMile".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [through, lifecycle, milestone] });
    await intent({ digest: through.digest, account: A.nova, source: story.ids.kaiWhyCommit });
    await intent({ digest: lifecycle.digest, account: A.nova, source: story.ids.openOpened });
    await intent({ digest: milestone.digest, account: A.nova, source: story.ids.milestone });

    assert.deepEqual(await pass(worker()), { resolved: 3, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((row) => row.status), ["applied", "applied", "applied"]);
    const rows = await attributions();
    assert.equal(rows.length, 3);
    // Through a person's post: its named author is credited.
    const credited = rows.find((row) => row.tx_digest === through.digest);
    assert.deepEqual(credited, {
      tx_digest: through.digest,
      entry_id: story.ids.kaiWhyCommit,
      author_account_id: A.kai,
      actor_account_id: A.nova,
      action: "commit",
      presale_id: P.open,
      quote_amount: "50000000",
      usd_value: "50",
      occurred_at_ms: String(through.timestamp_ms),
    });
    // Through a post nobody wrote: counted, with no author (AC-103).
    for (const digest of [lifecycle.digest, milestone.digest]) {
      const row = rows.find((candidate) => candidate.tx_digest === digest);
      assert.equal(row?.author_account_id, null, digest);
      assert.equal(row?.actor_account_id, A.nova, digest);
    }
  }));

test("T-026-AC-3 (AC-100): one's own post, another sale and a source stored as null credit nothing", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, worker }) => {
    const own = activity({ digest: "InOwn".padEnd(44, "1"), actor: W.kai });
    const elsewhere = activity({ digest: "InElse".padEnd(44, "1"), actor: W.nova, presale_id: P.funded, coin_type: `${P.funded}::coin::X` });
    const noSource = activity({ digest: "InNone".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [own, elsewhere, noSource] });
    // Kai blasting through kai's own post.
    await intent({ digest: own.digest, account: A.kai, source: story.ids.kaiWhyCommit });
    // Nova committing to another sale while naming a post of the open one.
    await intent({ digest: elsewhere.digest, account: A.nova, presale: P.funded, source: story.ids.kaiWhyCommit });
    // Registration found the source invisible and stored null.
    await intent({ digest: noSource.digest, account: A.nova, source: null });

    assert.deepEqual(await pass(worker()), { resolved: 3, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((row) => row.status), ["applied", "applied", "applied"]);
    assert.deepEqual(await attributions(), []);
  }));

test("T-026-AC-1 (AC-098): another wallet's transaction, and one made before the wallet was linked, are rejected", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, whys, worker }) => {
    // Nova claims a transaction kai's wallet sent.
    const notMine = activity({ digest: "InNotMine".padEnd(44, "1"), actor: W.kai });
    // The newcomer's own wallet, but two hours before it was linked.
    const beforeLink = activity({ digest: "InBefore".padEnd(44, "1"), actor: NEWCOMER_WALLET, timestamp_ms: NOW - 2 * HOUR });
    // The same wallet, after the link: that one is theirs.
    const afterLink = activity({ digest: "InAfter".padEnd(44, "1"), actor: NEWCOMER_WALLET, timestamp_ms: NOW - 30_000 });
    // A wallet nobody owns.
    const unowned = activity({ digest: "InAnon".padEnd(44, "1"), actor: W.anon });
    await seedChainRead(admin, { activity: [notMine, beforeLink, afterLink, unowned] });
    await intent({ digest: notMine.digest, account: A.nova, source: story.ids.kaiWhyCommit, why: "Not mine." });
    await intent({ digest: beforeLink.digest, account: NEWCOMER, source: story.ids.kaiWhyCommit, registeredMs: NOW - 2 * HOUR - 1_000 });
    await intent({ digest: afterLink.digest, account: NEWCOMER, source: story.ids.kaiWhyCommit, registeredMs: NOW - 31_000 });
    await intent({ digest: unowned.digest, account: A.nova, source: story.ids.kaiWhyCommit });

    assert.deepEqual(await pass(worker()), { resolved: 1, rejected: 3, late: 0 });
    const byDigest = new Map((await statuses()).map((row) => [row.tx_digest, row]));
    assert.equal(byDigest.get(notMine.digest)?.status, "rejected_sender");
    assert.equal(byDigest.get(beforeLink.digest)?.status, "rejected_sender");
    assert.equal(byDigest.get(unowned.digest)?.status, "rejected_sender");
    assert.equal(byDigest.get(afterLink.digest)?.status, "applied");
    // A rejected intent attaches nothing at all.
    assert.deepEqual((await attributions()).map((row) => row.tx_digest), [afterLink.digest]);
    assert.deepEqual(await whys(), []);
    // Every resolution is final: `resolved_at` is set exactly when it is not pending.
    for (const row of await statuses()) assert.equal(row.resolved_at !== null, row.status !== "pending", row.tx_digest);
  }));

test("T-026-AC-2 (AC-097): an intent registered 31 s after its event is late and attaches nothing", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, whys, worker }) => {
    const row = activity({ digest: "InLate".padEnd(44, "1"), actor: W.nova });
    const edge = activity({ digest: "InEdge".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [row, edge] });
    await intent({ digest: row.digest, account: A.nova, source: story.ids.kaiWhyCommit, why: "Too late.", registeredMs: row.timestamp_ms + 31_000 });
    // Exactly 30 s is not late.
    await intent({ digest: edge.digest, account: A.nova, source: story.ids.kaiWhyCommit, registeredMs: edge.timestamp_ms + 30_000 });

    assert.deepEqual(await pass(worker()), { resolved: 1, rejected: 0, late: 1 });
    const byDigest = new Map((await statuses()).map((candidate) => [candidate.tx_digest, candidate.status]));
    assert.equal(byDigest.get(row.digest), "late");
    assert.equal(byDigest.get(edge.digest), "applied");
    assert.deepEqual((await attributions()).map((candidate) => candidate.tx_digest), [edge.digest]);
    assert.deepEqual(await whys(), []);
  }));

test("T-026-AC-5 (AC-081): a valid checkout why becomes the new item's active why; one that fails is skipped", { skip }, () =>
  withDatabase(async ({ admin, intent, statuses, story, whys, worker }) => {
    const good = activity({ digest: "InWhyOk".padEnd(44, "1"), actor: W.kai });
    const linked = activity({ digest: "InWhyLink".padEnd(44, "1"), actor: W.kai });
    // `late_one` never shares, so its own item is not named and has no author.
    const unnamed = activity({ digest: "InWhyUnnamed".padEnd(44, "1"), actor: W.late });
    await seedChainRead(admin, { activity: [good, linked, unnamed] });
    await intent({ digest: good.digest, account: A.kai, why: "  Team shipped twice.  " });
    await intent({ digest: linked.digest, account: A.kai, why: "see https://blast.example" });
    await intent({ digest: unnamed.digest, account: A.late, why: "Mine, but nameless." });

    assert.deepEqual(await pass(worker()), { resolved: 3, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((row) => row.status), ["applied", "applied", "applied"]);
    const rows = await whys();
    // Exactly one why: the valid one, trimmed, on the item the commit produced.
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.entry_id, entryOf(good));
    assert.equal(rows[0]?.author_account_id, A.kai);
    assert.equal(rows[0]?.text, "Team shipped twice.");
    assert.equal(rows[0]?.state, "active");
    // 0066's trigger fills the sale from the activity row, so the sale page finds it.
    assert.equal(rows[0]?.presale_id, P.open);
    void story;
  }));

test("a competing active why does not roll back the intent or its attribution", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, whys, worker }) => {
    const row = activity({ digest: "InWhyRace".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [row] });
    await intent({ digest: row.digest, account: A.nova, source: story.ids.kaiWhyCommit, why: "From the checkout." });
    let raced = false;
    const steps = intentSteps({ batchSize: 50 }).map((step): SocialWorkerStep => ({
      ...step,
      run: (tx, bounds, context) => step.run({
        ...tx,
        async read<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
          const result = await tx.read<Row>(sql, values);
          if (sql === INTENT_STATEMENTS.whyRecords && !raced) {
            assert.equal(result.rows.length, 0);
            raced = true;
            await admin.query(
              "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, $4)",
              ["00000000-0000-4000-8000-000000009991", entryOf(row), A.nova, "Written in another tab."],
            );
          }
          return result;
        },
      }, bounds, context),
    }));

    assert.deepEqual(await pass(worker(undefined, steps)), { resolved: 1, rejected: 0, late: 0 });
    assert.equal(raced, true, "the competing write committed after the worker's read");
    assert.equal((await statuses())[0]?.status, "applied");
    assert.deepEqual((await attributions()).map((credit) => credit.tx_digest), [row.digest]);
    assert.deepEqual(await whys(), [{
      entry_id: entryOf(row), author_account_id: A.nova, text: "Written in another tab.", state: "active", presale_id: P.open,
    }]);
  }));

test("T-026-AC-4 (AC-101): running the step again and restarting the worker leave one attribution and one why", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, whys, worker }) => {
    const row = activity({ digest: "InTwice".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [row] });
    await intent({ digest: row.digest, account: A.nova, source: story.ids.kaiWhyCommit, why: "Once only." });

    const first = worker();
    assert.deepEqual(await pass(first), { resolved: 1, rejected: 0, late: 0 });
    const after = await statuses();
    // A second pass of the same worker, then a fresh one: both see nothing to do.
    assert.deepEqual(await pass(first), { resolved: 0, rejected: 0, late: 0 });
    await first.release();
    assert.deepEqual(await pass(worker()), { resolved: 0, rejected: 0, late: 0 });
    assert.deepEqual(await statuses(), after);
    assert.equal((await attributions()).length, 1);
    assert.equal((await whys()).length, 1);
  }));

test("T-026-AC-4 (AC-139): a sell attaches its why and credits nothing; a buy through a trade post credits it", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, whys, worker }) => {
    const sell = activity({
      digest: "InSell".padEnd(44, "1"),
      actor: W.kai,
      kind: "trade_sell",
      product: "market",
      presale_id: P.migratedRecently,
      coin_type: `${P.migratedRecently}::coin::X`,
      coin_amount: "40000000000",
    });
    const buy = activity({
      digest: "InBuy".padEnd(44, "1"),
      actor: W.nova,
      kind: "trade_buy",
      product: "market",
      presale_id: P.migratedRecently,
      coin_type: `${P.migratedRecently}::coin::X`,
      coin_amount: "900000000000",
    });
    await seedChainRead(admin, { activity: [sell, buy] });
    // Both name the same trade post of that sale, which has a `buy` descriptor.
    await intent({ digest: sell.digest, account: A.kai, action: "sell", presale: P.migratedRecently, source: story.ids.anonBigMigratedRecently, why: "Taking some off." });
    await intent({ digest: buy.digest, account: A.nova, action: "buy", presale: P.migratedRecently, source: story.ids.anonBigMigratedRecently });

    assert.deepEqual(await pass(worker()), { resolved: 2, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((row) => row.status), ["applied", "applied"]);
    // The sell's why attached; only the buy was credited.
    const rows = await attributions();
    assert.deepEqual(rows.map((row) => [row.tx_digest, row.action]), [[buy.digest, "buy"]]);
    assert.equal(rows[0]?.author_account_id, null, "an unowned wallet's post has no author");
    assert.deepEqual((await whys()).map((row) => [row.entry_id, row.text]), [[entryOf(sell), "Taking some off."]]);
  }));

test("T-026-AC-3: a commit resolved after its sale closed and funded still credits its post", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, worker }) => {
    const row = activity({ digest: "InFunded".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [row] });
    await intent({ digest: row.digest, account: A.nova, source: story.ids.kaiWhyCommit });
    // The sale closes and funds between the registration and the resolution.
    await admin.query("UPDATE blast_infra_fixture.presales SET lifecycle = 'funded', end_ms = $2 WHERE presale_id = $1", [P.open, NOW - MINUTE]);

    assert.deepEqual(await pass(worker()), { resolved: 1, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((candidate) => candidate.status), ["applied"]);
    // The descriptor is no longer enabled, and the credit still stands.
    assert.deepEqual((await attributions()).map((candidate) => [candidate.tx_digest, candidate.entry_id]), [[row.digest, story.ids.kaiWhyCommit]]);
  }));

test("T-026-AC-6 (AC-169): an intent resolves in the pass after its activity row appears, and nothing before it", { skip }, () =>
  withDatabase(async ({ admin, attributions, intent, statuses, story, worker }) => {
    const row = activity({ digest: "InWaits".padEnd(44, "1"), actor: W.nova });
    await intent({ digest: row.digest, account: A.nova, source: story.ids.kaiWhyCommit, registeredMs: row.timestamp_ms - 1_000 });
    const running = worker();
    // No activity row yet: the intent stays pending and costs the step nothing.
    assert.deepEqual(await pass(running), { resolved: 0, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((candidate) => candidate.status), ["pending"]);
    // The indexer catches up; the next pass applies it. At the worker's 5 s
    // interval that is well inside the 10 s the acceptance criterion allows.
    await seedChainRead(admin, { activity: [row] });
    assert.deepEqual(await pass(running), { resolved: 1, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((candidate) => candidate.status), ["applied"]);
    assert.equal((await attributions()).length, 1);
  }));

test("T-026-AC-6 (AC-099, AC-130): a 25-hour-old pending intent is deleted, and no worker line carries a why", { skip }, (context) =>
  withDatabase(async ({ admin, intent, lines, statuses, story, worker }) => {
    const secret = "secret-why-text-4b2e";
    const consoleLines: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      context.mock.method(console, method, (...args: unknown[]) => {
        consoleLines.push(args.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
      });
    }
    const stale = activity({ digest: "InStale".padEnd(44, "1"), actor: W.nova });
    const fresh = activity({ digest: "InFresh".padEnd(44, "1"), actor: W.nova });
    // The stale one's transaction never appeared: nothing can resolve it.
    await seedChainRead(admin, { activity: [fresh] });
    await intent({ digest: stale.digest, account: A.nova, why: `${secret} stale`, registeredMs: NOW - 25 * HOUR });
    await intent({ digest: fresh.digest, account: A.nova, source: story.ids.kaiWhyCommit, why: `${secret} fresh` });
    // A pending intent registered 23 hours ago is kept: the window is 24.
    await intent({ digest: "InKept".padEnd(44, "1"), account: A.nova, why: `${secret} kept`, registeredMs: NOW - 23 * HOUR });

    assert.deepEqual(await pass(worker(() => NOW)), { resolved: 1, rejected: 0, late: 0 });
    assert.deepEqual(
      (await statuses()).map((row) => [row.tx_digest.replace(/1+$/, ""), row.status]),
      [["InFresh", "applied"], ["InKept", "pending"]],
    );
    // The pass line carries the three intent counts and not one why.
    const pass1 = lines.filter((line) => line.metric === "social.worker.pass");
    assert.ok(pass1.length > 0);
    for (const field of ["intents_resolved", "intents_rejected", "intents_late"]) assert.ok(field in pass1[0]!, field);
    for (const line of lines) assert.ok(!JSON.stringify(line).includes(secret), JSON.stringify(line));
    for (const line of consoleLines) assert.ok(!line.includes(secret), line);
  }));

test("T-026: the step reads nothing past the watermark, so a half-indexed checkpoint waits", { skip }, () =>
  withDatabase(async ({ admin, intent, statuses, story, worker }) => {
    // The feed story commits the presale pipeline at 40,000.
    const ahead = activity({ digest: "InAhead".padEnd(44, "1"), actor: W.nova, checkpoint: 41_000 });
    await seedChainRead(admin, { activity: [ahead] });
    await intent({ digest: ahead.digest, account: A.nova, source: story.ids.kaiWhyCommit });
    // One worker throughout: a second would stand by behind the first's lease.
    const running = worker();
    assert.deepEqual(await pass(running), { resolved: 0, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((row) => row.status), ["pending"]);
    // Once the pipeline commits that checkpoint it resolves.
    await admin.query(advanceWatermark(41_000, 0, "presale"));
    assert.deepEqual(await pass(running), { resolved: 1, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((row) => row.status), ["applied"]);
  }));

test("R3-27 (migration 0085): the worker settles each logged commit from the chain, and only ever moves it forward", { skip }, () =>
  withDatabase(async ({ admin, intent, worker }) => {
    // What the route logs with each registration (R3-27): `submitted`, with the
    // digest. The log's digests are base58 (no I, l, O or 0), unlike the other
    // tests' fixture digests.
    const logCommit = async (digest: string, account: string, createdAtMs: number) =>
      admin.query(
        `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, quote_type, quote_amount, usd_value, idempotency_key, created_at_ms)
         VALUES (gen_random_uuid(), $1, 'commit', 'submitted', $2, $3, $4, 50000000, 50, 'commit:' || $2, $5)`,
        [account, digest, P.open, FEED_STORY_QUOTE_TYPE, createdAtMs],
      );
    type Logged = Readonly<{ digest: string; state: string; failure_code: string | null; settled_at_ms: string | null }>;
    const log = async () =>
      new Map(
        (
          await admin.query<Logged>(
            "SELECT digest, state, failure_code, settled_at_ms::text FROM social_transactions WHERE idempotency_key LIKE 'commit:Lg%'",
          )
        ).rows.map((row) => [row.digest, row]),
      );

    // Nova's own commit; a late registration of nova's own commit; nova claiming kai's transaction.
    const mine = activity({ digest: "LgMine".padEnd(44, "1"), actor: W.nova });
    const late = activity({ digest: "LgLate".padEnd(44, "1"), actor: W.nova });
    const theirs = activity({ digest: "LgTheirs".padEnd(44, "1"), actor: W.kai });
    // Never on chain (a refused signature after registration): it expires.
    const lost = "LgLost".padEnd(44, "1");
    // Already settled by someone else: the worker leaves it alone.
    const settled = activity({ digest: "LgDone".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [mine, late, theirs, settled] });
    for (const row of [mine, theirs, settled]) {
      await intent({ digest: row.digest, account: A.nova });
      await logCommit(row.digest, A.nova, NOW - 5 * MINUTE - 1_000);
    }
    await intent({ digest: late.digest, account: A.nova, registeredMs: NOW - 5 * MINUTE + 31_000 });
    await logCommit(late.digest, A.nova, NOW - 5 * MINUTE + 31_000);
    await intent({ digest: lost, account: A.nova, registeredMs: NOW - 25 * HOUR });
    await logCommit(lost, A.nova, NOW - 25 * HOUR);
    await admin.query(
      "UPDATE social_transactions SET state = 'failed', failure_code = 'rejected', settled_at_ms = $2 WHERE digest = $1",
      [settled.digest, NOW - 4 * MINUTE],
    );
    // An intent registered before 0084 has no row: nothing is inserted for it.
    const unlogged = activity({ digest: "LgNone".padEnd(44, "1"), actor: W.nova });
    await seedChainRead(admin, { activity: [unlogged] });
    await intent({ digest: unlogged.digest, account: A.nova });

    const first = worker(() => NOW);
    assert.deepEqual(await pass(first), { resolved: 3, rejected: 1, late: 1 });
    const rows = await log();
    // Its own wallet sent it: confirmed at the chain's time. A late registration voids the credit, not the commitment.
    assert.deepEqual(rows.get(mine.digest), { digest: mine.digest, state: "confirmed", failure_code: null, settled_at_ms: String(mine.timestamp_ms) });
    assert.equal(rows.get(late.digest)?.state, "confirmed");
    // The settled time is never before the row was created (the late row was logged after the event).
    assert.equal(rows.get(late.digest)?.settled_at_ms, String(NOW - 5 * MINUTE + 31_000));
    // Another wallet's transaction is not this account's.
    assert.deepEqual(rows.get(theirs.digest), { digest: theirs.digest, state: "failed", failure_code: "mismatch", settled_at_ms: String(theirs.timestamp_ms) });
    // Never seen in 24 hours: expired, and its intent is gone.
    assert.equal(rows.get(lost)?.state, "failed");
    assert.equal(rows.get(lost)?.failure_code, "expired");
    // A row already settled stays as it was; no row is ever invented.
    assert.equal(rows.get(settled.digest)?.failure_code, "rejected");
    assert.equal(rows.has(unlogged.digest), false);

    // A second pass and a restarted worker change nothing.
    const before = JSON.stringify([...(await log()).entries()].sort());
    await pass(first);
    await first.release();
    await pass(worker(() => NOW));
    assert.equal(JSON.stringify([...(await log()).entries()].sort()), before);
  }));

test("T-043 hidden sales: a checkout why on a commit to a hidden sale is not stored; the intent still applies", { skip }, () =>
  withDatabase(async ({ admin, intent, statuses, whys, worker }) => {
    // T-043's excluded test sale (no `presales` row, its activity kept) and a sale with no coin metadata.
    const excluded = activity({ digest: "InHiddenX".padEnd(44, "1"), actor: W.kai, presale_id: FEED_STORY_HIDDEN.excluded, coin_type: FEED_STORY_HIDDEN.excludedCoin });
    const incomplete = activity({ digest: "InHiddenI".padEnd(44, "1"), actor: W.kai, presale_id: FEED_STORY_HIDDEN.incomplete, coin_type: FEED_STORY_HIDDEN.incompleteCoin });
    const shown = activity({ digest: "InShown".padEnd(44, "1"), actor: W.kai });
    await seedChainRead(admin, {
      activity: [excluded, incomplete, shown],
      presales: [{
        presale_id: FEED_STORY_HIDDEN.incomplete, sale_token: FEED_STORY_HIDDEN.incompleteCoin, quote_type: FEED_STORY_QUOTE_TYPE,
        sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null, quote_symbol: "USDC", quote_decimals: 6, lifecycle: "open",
        start_ms: NOW - DAY, end_ms: NOW + DAY, raise_target: "100000000000", min_commitment: "1000000", wallet_cap: null,
        total_commitments: "0", participants: 0, venue: "cetus", pool_id: null, updated_checkpoint: 20_000,
      }],
    });
    // Only a hand-made request registers these: the dialog opens from a shown sale's page.
    await intent({ digest: excluded.digest, account: A.kai, presale: FEED_STORY_HIDDEN.excluded, why: "Test sale thesis." });
    await intent({ digest: incomplete.digest, account: A.kai, presale: FEED_STORY_HIDDEN.incomplete, why: "No metadata yet." });
    await intent({ digest: shown.digest, account: A.kai, why: "A real thesis." });

    assert.deepEqual(await pass(worker()), { resolved: 3, rejected: 0, late: 0 });
    assert.deepEqual((await statuses()).map((row) => row.status), ["applied", "applied", "applied"]);
    assert.deepEqual((await whys()).map((row) => [row.entry_id, row.text]), [[entryOf(shown), "A real thesis."]]);
  }));
