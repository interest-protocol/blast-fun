import { withSocialCoverage, seedSocialCheckpoint } from "../../../../test/fixtures/modules/social/worker/shared-evidence-fixture.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { TransactionError } from "@mysten/sui/client";
import type { Pool } from "pg";

import { seedChainRead, type ChainActivityRow } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { FIXTURE_NETWORK, FIXTURE_FINGERPRINT, urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { CLAIM_SENT_EXPIRY_MS, CLAIM_UNSENT_EXPIRY_MS, type SocialClaimKind } from "@blast/core/modules/social/contracts/claims.ts";
import { claimIdempotencyKey } from "@blast/core/modules/social/claims/identity.ts";
import { VESTING_CLAIM_PAGE_SQL, CLAIM_VESTING_EVIDENCE_BATCH } from "#workers/modules/social/claims/vesting.ts";
import { PRESALE_STORY_ACCOUNTS, PRESALE_STORY_WALLETS, seedPresaleStory, type PresaleStory } from "../../../../../../packages/core/test/fixtures/modules/social/presales/presale-story.ts";
import { createSocialAlerts } from "#workers/modules/social/worker/alerts.ts";
import { socialWorkerConfigFromEnvironment } from "../worker/config.ts";
import { createSocialWorker, type SocialPassReport } from "../worker/runtime.ts";
import { CLAIM_EXPIRY_EVERY_MS, claimSteps, type VestingClaimExecution } from "#workers/modules/social/claims/settle.ts";
import { uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * R3-63's worker steps on a disposable database, as `blast_watcher` on the
 * social worker runtime: a claim the browser recorded and never came back to
 * settle is settled from `chain_read_v1.activity` (up to the presale
 * pipeline's watermark), and one that never reached the chain is `expired`
 * on the chain's clock. Rows are inserted as the claim route writes them
 * (its own suite is `claims.integration.test.ts`).
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 2, statementTimeoutMs: 10_000 };
const NOW = Date.UTC(2026, 9, 4, 17);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const KAI = PRESALE_STORY_ACCOUNTS.kai;
const KAI_WALLET = PRESALE_STORY_WALLETS.kai;
const LUCA_WALLET = PRESALE_STORY_WALLETS.luca;
const WATERMARK = 90_000;
/**
 * How long the fixture's stand-in for the shared indexer waits on a digest
 * read. The worker never calls a probe: it reads evidence from the database.
 */
const INDEXER_READ_DEADLINE_MS = 250;

/** A base58 digest per claim (no 0, O, I or l). */
const digest = (n: number) => `Ck${n.toString().replace(/0/g, "z").padStart(4, "z")}`.padEnd(44, "1");
const schedule = (n: number) => `0x${(0x7000 + n).toString(16).padStart(64, "0")}`;
const VestingClaimed = bcs.struct("VestingClaimed", {
  vesting_id: bcs.Address, coin_type: bcs.struct("TypeName", { name: bcs.string() }), beneficiary: bcs.Address,
  amount: bcs.u64(), released_total: bcs.u64(),
});

function vestingEvent(scheduleId: string, coinType: string, beneficiary = KAI_WALLET) {
  return {
    eventType: `${VESTING_PACKAGE}::blast_fun_linear_vesting::VestingClaimed`,
    bcs: VestingClaimed.serialize({ vesting_id: scheduleId, coin_type: { name: coinType.slice(2) }, beneficiary, amount: 5n, released_total: 5n }).toBytes(),
  };
}

type SharedVestingFixture = (digest: string, options: Readonly<{ signal: AbortSignal }>) => Promise<VestingClaimExecution | null>;

type Fixture = Readonly<{
  admin: Pool;
  story: PresaleStory;
  /** One pass of the claim steps, the chain's clock at `chainNowMs`. */
  pass(chainNowMs?: number, checkpoint?: number): Promise<SocialPassReport>;
  /** A claim row as the route logs it. */
  claim(n: number, input: Readonly<{ presale: string; kind?: SocialClaimKind; digest?: string | null; createdMs: number; account?: string; scheduleId?: string; coinType?: string }>): Promise<void>;
  rows(): Promise<Array<Readonly<{ tx_id: string; state: string; failure_code: string | null; settled_at_ms: string | null }>>>;
}>;

async function withDatabase(run: (fixture: Fixture) => Promise<void>, vestingProbe?: SharedVestingFixture): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const watcher = createRuntimePool(urlAs(database.url, "blast_watcher"), POOL, "claims-watcher-test");
  try {
    const story = await seedPresaleStory(admin, { nowMs: NOW, crowd: 4 });
    // A failed pass's step errors, so an "error" outcome says which step failed and why (#652).
    const stepErrors: unknown[] = [];
    const log = (event: string, fields?: unknown) => { if (event === "social.worker.step_error") stepErrors.push(fields); };
    let holder = 0;
    const worker = () => {
      holder += 1;
      return withSocialCoverage(createSocialWorker({
        selection: { network: FIXTURE_NETWORK, deployment: FIXTURE_FINGERPRINT },
        pool: watcher,
        steps: claimSteps({ batchSize: 50 }),
        config: socialWorkerConfigFromEnvironment({}),
        holder: uuid(0xf000 + holder),
        log,
        alerts: createSocialAlerts({ webhookUrl: null, log }),
      }), admin);
    };
    const once = worker();
    await run({
      admin,
      story,
      async pass(chainNowMs = NOW, checkpoint = WATERMARK) {
        await admin.query(
          "UPDATE watermarks SET checkpoint_hi_inclusive = $1, timestamp_ms_hi_inclusive = $2 WHERE pipeline = 'presale'",
          [checkpoint, chainNowMs],
        );

        if (vestingProbe) {
          const cursor = (await admin.query("SELECT value FROM social_worker_state WHERE name='claim-vesting-settle'")).rows[0]?.value;
          const page = (await admin.query(VESTING_CLAIM_PAGE_SQL, [cursor?.created_at_ms ?? null, cursor?.tx_id ?? null, CLAIM_VESTING_EVIDENCE_BATCH])).rows;
          const controller = new AbortController();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve(null); }, INDEXER_READ_DEADLINE_MS); });
          try {
            await Promise.all(page.map(async (row: { digest: string }) => {
              const execution = await Promise.race([vestingProbe(row.digest, { signal: controller.signal }).catch(() => null), deadline]);
              if (!execution || execution.checkpoint === null || execution.timestampMs === null) return;
              await seedSocialCheckpoint(admin, execution.checkpoint, execution.timestampMs);
              await admin.query(`INSERT INTO blast_infra_fixture.transaction_evidence(digest,checkpoint,timestamp_ms,sender,success,events)
                SELECT $1,$2,$3,$4,$5,coalesce(jsonb_agg(jsonb_build_object(
                  'eventType', event->>'eventType',
                  'bcs', encode(decode(event->>'bcs', 'base64'), 'base64')
                ) ORDER BY position), '[]'::jsonb)
                FROM jsonb_array_elements($6::jsonb) WITH ORDINALITY AS native(event, position)
                ON CONFLICT(digest) DO NOTHING`, [
                execution.digest, execution.checkpoint, execution.timestampMs, execution.sender, execution.success,
                JSON.stringify(execution.events.map((event) => ({ eventType: event.eventType, bcs: Buffer.from(event.bcs).toString("base64") }))),
              ]);
            }));
          } finally { clearTimeout(timer); controller.abort(); }
        }
        stepErrors.length = 0;
        const report = await once.runPass();
        assert.equal(report.outcome, "ok", `pass step errors: ${JSON.stringify(stepErrors)}`);
        return report;
      },
      async claim(n, { presale, kind = "claim_refund", digest: sent = null, createdMs, account = KAI, scheduleId, coinType = null }) {
        await admin.query(
          `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, idempotency_key, created_at_ms, coin_type)
           VALUES ($1::uuid, $2, $3, 'submitted', $4, $5, $6, $7, $8)`,
          [uuid(n), account, kind, sent, presale, scheduleId === undefined ? `${kind}:${uuid(n)}` : claimIdempotencyKey(kind, uuid(n), scheduleId), createdMs, coinType],
        );
      },
      async rows() {
        return (await admin.query(
          "SELECT tx_id::text, state, failure_code, settled_at_ms::text FROM social_transactions ORDER BY tx_id",
        )).rows;
      },
    });
    await once.release();
  } finally {
    await watcher.end();
    await admin.end();
    await database.drop();
  }
}

let slot = 0;
function claimRow(input: Readonly<{ digest: string; actor: string; presale: string; checkpoint?: number; timestampMs?: number }>): ChainActivityRow {
  slot += 1;
  return {
    checkpoint: input.checkpoint ?? WATERMARK - 10, tx_slot: slot, event_slot: 0, part: 0, timestamp_ms: input.timestampMs ?? NOW - MINUTE,
    digest: input.digest, kind: "presale_claim", product: "presale", actor: input.actor, tx_sender: input.actor,
    presale_id: input.presale, coin_type: null, quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
    quote_amount: "0", coin_amount: null, quote_refund: "250000000", usd_value: null, usd_price_as_of_ms: null,
    venue: null, participants_after: null, total_commitments_after: null,
  };
}

test("R3-63-AC-5: a claim the browser left open settles from the indexer: Kai's claim confirmed, another wallet's a mismatch, past the watermark waits", { skip }, async () => {
  await withDatabase(async ({ admin, story, pass, claim, rows }) => {
    const halcyon = story.presaleIds.HLCN!;
    const kestrel = story.presaleIds.KSTL!;
    await claim(1, { presale: halcyon, digest: digest(1), createdMs: NOW - 10 * MINUTE });
    await claim(2, { presale: halcyon, digest: digest(2), createdMs: NOW - 9 * MINUTE });
    await claim(3, { presale: kestrel, kind: "claim_tokens", digest: digest(3), createdMs: NOW - 8 * MINUTE });
    await claim(4, { presale: halcyon, digest: digest(4), createdMs: NOW - 7 * MINUTE });
    // A commit with a digest is T-026's to settle, never this step's.
    await admin.query(
      `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, idempotency_key, created_at_ms)
       VALUES ($1, $2, 'commit', 'submitted', $3, $4, $5, $6)`,
      [uuid(9), KAI, digest(9), halcyon, `commit:${digest(9)}`, NOW - 5 * MINUTE],
    );
    await seedChainRead(admin, {
      activity: [
        claimRow({ digest: digest(1), actor: KAI_WALLET, presale: halcyon, timestampMs: NOW - 2 * MINUTE }),
        // Paid someone else (Luca's wallet is not Kai's account's): not this account's claim.
        claimRow({ digest: digest(2), actor: LUCA_WALLET, presale: halcyon }),
        // Kai's own claim, but past the presale watermark: not read yet.
        claimRow({ digest: digest(3), actor: KAI_WALLET, presale: kestrel, checkpoint: WATERMARK + 5 }),
        claimRow({ digest: digest(9), actor: KAI_WALLET, presale: halcyon }),
      ],
    });

    const first = await pass();
    assert.deepEqual([first.counts.claims_confirmed, first.counts.claims_failed], [1, 1]);
    const settled = await rows();
    assert.deepEqual(
      settled.map((row) => [row.tx_id.slice(-2), row.state, row.failure_code]),
      [["01", "confirmed", null], ["02", "failed", "mismatch"], ["03", "submitted", null], ["04", "submitted", null], ["09", "submitted", null]],
    );
    // At the chain's time, never before the row was created.
    assert.equal(settled[0]!.settled_at_ms, String(NOW - 2 * MINUTE));

    // The indexer moves on: the waiting claim confirms; a repeat pass changes nothing; an aborted claim (no event) stays.
    const second = await pass(NOW, WATERMARK + 10);
    assert.equal(second.counts.claims_confirmed, 1);
    const third = await pass(NOW, WATERMARK + 10);
    assert.deepEqual([third.counts.claims_confirmed, third.counts.claims_failed], [0, 0]);
    assert.deepEqual(
      (await rows()).map((row) => [row.tx_id.slice(-2), row.state]),
      [["01", "confirmed"], ["02", "failed"], ["03", "confirmed"], ["04", "submitted"], ["09", "submitted"]],
    );
  });
});

test("R3-63-AC-6: on the chain's clock, an attempt never sent expires after an hour and one sent but never seen after a day, at most every ten minutes", { skip }, async () => {
  await withDatabase(async ({ story, pass, claim, rows }) => {
    const halcyon = story.presaleIds.HLCN!;
    await claim(1, { presale: halcyon, createdMs: NOW - CLAIM_UNSENT_EXPIRY_MS - MINUTE });
    await claim(2, { presale: halcyon, createdMs: NOW - CLAIM_UNSENT_EXPIRY_MS + 5 * MINUTE });
    await claim(3, { presale: halcyon, digest: digest(3), createdMs: NOW - CLAIM_SENT_EXPIRY_MS - MINUTE });
    await claim(4, { presale: halcyon, digest: digest(4), createdMs: NOW - 2 * HOUR });

    const first = await pass(NOW);
    assert.equal(first.counts.claims_expired, 2);
    assert.deepEqual(
      (await rows()).map((row) => [row.tx_id.slice(-2), row.state, row.failure_code]),
      [["01", "failed", "expired"], ["02", "submitted", null], ["03", "failed", "expired"], ["04", "submitted", null]],
    );
    // Within ten minutes of the last sweep nothing more expires, even what has come of age meanwhile.
    const soon = await pass(NOW + 9 * MINUTE);
    assert.equal(soon.counts.claims_expired, 0);
    assert.equal((await rows())[1]!.state, "submitted");
    const later = await pass(NOW + CLAIM_EXPIRY_EVERY_MS + MINUTE);
    assert.equal(later.counts.claims_expired, 1);
    assert.deepEqual((await rows()).map((row) => row.state), ["failed", "failed", "failed", "submitted"]);
  });
});

test("P-13 recovery: a presale receipt cannot confirm a vesting attempt; sent vesting claims with no evidence expire, ones with evidence wait", { skip }, async () => {
  await withDatabase(async ({ admin, story, pass, claim, rows }) => {
    const presale = story.presaleIds.KSTL!;
    const scheduleId = `0x${"70".repeat(32)}`;
    const createdMs = NOW - CLAIM_SENT_EXPIRY_MS - MINUTE;
    await claim(1, { presale, kind: "claim_vesting", scheduleId, digest: digest(1), createdMs });
    // An old attempt never recorded its schedule: no evidence can bind it safely.
    await claim(2, { presale, kind: "claim_vesting", digest: digest(2), createdMs });
    await claim(3, { presale, kind: "claim_vesting", scheduleId, createdMs });
    // Evidence past the watermark: the vesting step settles it once the watermark gets there.
    await claim(4, { presale, kind: "claim_vesting", scheduleId, digest: digest(4), createdMs });
    // Sent within the day: not yet past expiry.
    await claim(5, { presale, kind: "claim_vesting", scheduleId, digest: digest(5), createdMs: NOW - HOUR });
    await seedChainRead(admin, { activity: [claimRow({ digest: digest(1), actor: KAI_WALLET, presale })] });
    await seedSocialCheckpoint(admin, WATERMARK + 5, NOW);
    await admin.query(`INSERT INTO blast_infra_fixture.transaction_evidence(digest,checkpoint,timestamp_ms,sender,success,events)
      VALUES ($1,$2,$3,$4,true,'[]'::jsonb)`, [digest(4), WATERMARK + 5, NOW, KAI_WALLET]);

    const report = await pass();
    assert.equal(report.counts.claims_confirmed, 0, "a Claimed receipt is not a VestingClaimed receipt");
    assert.equal(report.counts.claims_expired, 3, "a day without evidence is an attempt that never ran");
    assert.deepEqual((await rows()).map((row) => [row.state, row.failure_code]), [
      ["failed", "expired"], ["failed", "expired"], ["failed", "expired"], ["submitted", null], ["submitted", null],
    ]);
  });
});

test("P-13 recovery: exact executed vesting events settle once; other schedules, sales, wallets and packages fail; future or unavailable executions wait", { skip }, async () => {
  const executions = new Map<string, VestingClaimExecution>();
  const calls: string[] = [];
  const probe: SharedVestingFixture = async (sent, { signal }) => {
    assert.equal(signal.aborted, false);
    calls.push(sent);
    if (sent === digest(8)) throw new TransactionError("notFound", sent);
    return executions.get(sent) ?? null;
  };
  await withDatabase(async ({ admin, story, pass, claim, rows }) => {
    const presale = story.presaleIds.KSTL!;
    const coinType = story.saleTokens.KSTL!;
    // Within the expiry window: unavailable evidence waits rather than expiring.
    const createdMs = NOW - HOUR;
    await seedChainRead(admin, {
      vesting_schedules: Array.from({ length: 13 }, (_, index) => ({
        schedule_id: schedule(index + 1), presale_id: index === 3 ? story.presaleIds.HLCN! : presale,
        beneficiary: index === 12 ? LUCA_WALLET : KAI_WALLET, total: "100", claimed: "100", start_ms: NOW - 2 * HOUR, cliff_ms: "0", end_ms: String(NOW - HOUR),
      })),
    });
    for (let n = 1; n <= 13; n += 1) {
      await claim(n, { presale, kind: "claim_vesting", scheduleId: schedule(n), coinType, digest: digest(n), createdMs });
      executions.set(digest(n), {
        digest: digest(n), checkpoint: String(WATERMARK - 10), timestampMs: NOW - MINUTE,
        sender: KAI_WALLET, success: true, events: [vestingEvent(schedule(n), coinType)],
      });
    }
    const change = (n: number, extra: Partial<VestingClaimExecution>) => executions.set(digest(n), { ...executions.get(digest(n))!, ...extra });
    change(2, { events: [vestingEvent(schedule(2), coinType, LUCA_WALLET)] });
    change(3, { events: [vestingEvent(schedule(99), coinType)] });
    change(5, { sender: LUCA_WALLET });
    change(6, { success: false, events: [] });
    change(7, { checkpoint: String(WATERMARK + 5) });
    executions.delete(digest(9));
    change(10, { digest: digest(99) });
    const lookalike = vestingEvent(schedule(11), coinType);
    change(11, { events: [{ ...lookalike, eventType: lookalike.eventType.replace(VESTING_PACKAGE, `0x${"77".repeat(32)}`) }] });
    change(12, { events: [vestingEvent(schedule(12), "0x2::sui::SUI")] });
    change(13, { sender: LUCA_WALLET, events: [vestingEvent(schedule(13), coinType, LUCA_WALLET)] });

    const first = await pass();
    assert.deepEqual([first.counts.claims_confirmed, first.counts.claims_failed, first.counts.claims_expired], [1, 8, 0]);
    assert.deepEqual((await rows()).map((row) => [row.state, row.failure_code]), [
      ["confirmed", null], ["failed", "mismatch"], ["failed", "mismatch"], ["failed", "mismatch"],
      ["failed", "mismatch"], ["failed", "execution_failed"], ["submitted", null], ["submitted", null],
      ["submitted", null], ["submitted", null], ["failed", "mismatch"], ["failed", "mismatch"], ["failed", "mismatch"],
    ]);
    assert.equal((await rows())[0]!.settled_at_ms, String(NOW - MINUTE));
    assert.equal(calls.length, 13);

    const second = await pass(NOW, WATERMARK + 10);
    assert.equal(second.counts.claims_confirmed, 0, "the completed page resets the cursor before revisiting pending attempts");
    const third = await pass(NOW, WATERMARK + 10);
    assert.equal(third.counts.claims_confirmed, 1, "the future checkpoint confirms only after the watermark reaches it");
    const fourth = await pass(NOW, WATERMARK + 10);
    assert.deepEqual([fourth.counts.claims_confirmed, fourth.counts.claims_failed], [0, 0]);
    assert.equal(calls.filter((sent) => sent === digest(1)).length, 1, "settled rows are not probed again");
    assert.deepEqual((await rows()).slice(7, 10).map((row) => row.state), ["submitted", "submitted", "submitted"], "claimed totals do not prove unavailable or unrelated executions");
  }, probe);
});

// No test timeout: database setup alone takes over 6 s and the fixture's deadline is a plain timer.
test("Shared recovery: missing evidence does not starve a bounded page, and the next covered claim settles", { skip }, async () => {
  const signals: AbortSignal[] = [];
  let healthy: VestingClaimExecution | null = null;
  const probe: SharedVestingFixture = async (sent, { signal }) => {
    signals.push(signal);
    if (sent === healthy?.digest) return healthy;
    // A read that ignores abort: the indexer stand-in gives up on it at its deadline.
    return new Promise(() => undefined);
  };
  await withDatabase(async ({ admin, story, pass, claim, rows }) => {
    const presale = story.presaleIds.KSTL!;
    const coinType = story.saleTokens.KSTL!;
    const count = CLAIM_VESTING_EVIDENCE_BATCH + 1;
    await seedChainRead(admin, {
      vesting_schedules: Array.from({ length: count }, (_, index) => ({
        schedule_id: schedule(index + 1), presale_id: presale, beneficiary: KAI_WALLET,
        total: "100", claimed: "100", start_ms: NOW - 2 * HOUR, cliff_ms: "0", end_ms: String(NOW - HOUR),
      })),
    });
    for (let n = 1; n <= count; n += 1) {
      await claim(n, { presale, kind: "claim_vesting", scheduleId: schedule(n), coinType, digest: digest(n), createdMs: NOW - HOUR });
    }
    healthy = { digest: digest(count), checkpoint: String(WATERMARK - 1), timestampMs: NOW - MINUTE, sender: KAI_WALLET, success: true, events: [vestingEvent(schedule(count), coinType)] };

    const timedOut = await pass();
    assert.equal(timedOut.counts.claims_expired, 0);
    assert.equal(signals.length, CLAIM_VESTING_EVIDENCE_BATCH, "a page holds at most the evidence batch, though the worker's batch size is fifty");
    assert.ok(signals.every((signal) => signal.aborted), "the shared deadline aborts every outstanding read");
    assert.ok((await rows()).every((row) => row.state === "submitted"));

    const next = await pass();
    assert.equal(next.counts.claims_confirmed, 1, "unavailable older digests do not starve the next page");
    assert.equal(signals.length, count);
    assert.equal((await rows()).at(-1)!.state, "confirmed");
  }, probe);
});
