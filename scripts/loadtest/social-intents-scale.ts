// Social feed T-024 and T-026 scale evidence: registering an intent and
// resolving it at launch scale, with their plans.
//
//   SOCIAL_SCALE_DATABASE_URL=postgresql://postgres:<pw>@127.0.0.1:<port>/<db> \
//     node --no-warnings --experimental-strip-types loadtest/social-scale.ts seed
//   SOCIAL_SCALE_DATABASE_URL=… node --no-warnings --experimental-strip-types scripts/loadtest/social-intents-scale.ts seed|bench
//
// `seed` adds the intent volume to `social-scale.ts`'s launch-scale database
// (10k accounts, 1M activity rows, 100k follows): 500k resolved intents — the
// airdrop's evidence, which is never pruned — plus 2,000 still pending, and
// 300k attributions over 20k posts. That ratio is the point: the worker's step
// and its expiry both work on the pending slice only, so their cost must not
// grow with the half-million rows beside it.
//
// `bench` times each statement as the role that runs it (`blast_web` for the
// route, `blast_watcher` for the worker) inside a transaction it rolls back,
// so every run sees the same data, and writes
// loadtest/results/social-intents-timings.json and -plans.txt.
import fs from "node:fs";

import pg from "pg";

import { urlAs } from "../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { INTENT_INSERT_SQL, INTENT_OWNER_SQL } from "@blast/server/modules/social/intents/route.ts";
import { INTENT_STATEMENTS } from "../../apps/workers/src/modules/social/intents/resolve.ts";
import { isVisible } from "@blast/core/modules/social/read-model/entries.ts";
import { SETTLE_LOGGED_SQL } from "@blast/core/modules/social/transactions/log.ts";

const URL_ = process.env.SOCIAL_SCALE_DATABASE_URL ?? "";
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost):\d+\/\w+$/.test(URL_)) {
  throw new Error("SOCIAL_SCALE_DATABASE_URL must name a disposable loopback database.");
}
const ACCOUNTS = 10_000;
const RESOLVED = 500_000;
const PENDING = 2_000;
const ATTRIBUTIONS = 300_000;
const BATCH = 500;
const THRESHOLDS = { bigCommitUsd: "1000", bigTradeUsd: "1000" };
const account = (n: string) => `('00000000-0000-4000-8000-' || lpad(to_hex(${n}), 12, '0'))::uuid`;
/**
 * A base58 digest, deterministic and **injective** in `n`. Base58 has no `0`,
 * `O`, `I` or `l`, and hex has no `g` or `z`, so mapping `0` to `g` and
 * padding with `z` keeps every digest distinct — mapping a hex digit to
 * another hex digit would not, and `ON CONFLICT DO NOTHING` would then drop a
 * third of the rows without a word.
 */
const digest = (n: string) => `('Ls' || translate(lpad(to_hex(${n}), 42, 'z'), '0', 'g'))`;

async function seed() {
  const admin = new pg.Pool({ connectionString: URL_, max: 2 });
  // Half a million resolved intents: applied, late and rejected, none of them
  // in the partial index the worker reads.
  await admin.query(
    `INSERT INTO social_intents (tx_digest, account_id, action, presale_id, source_entry_id, why_text, registered_at, status, resolved_at)
     SELECT ${digest("i")}, ${account(`1 + i % ${ACCOUNTS}`)}, 'commit', '0x' || lpad('5a1e' || to_hex(i % 60), 64, '0'),
       CASE WHEN i % 3 = 0 THEN 'a:' || (100000 + (i % 20000) * 37) || ':0:0:0' END,
       CASE WHEN i % 4 = 0 THEN 'Scale reason ' || i END,
       now() - ((i % 5184000) || ' seconds')::interval,
       (ARRAY['applied','applied','applied','applied','applied','applied','applied','applied','late','rejected_sender'])[1 + i % 10],
       now() - ((i % 5184000) || ' seconds')::interval
     FROM generate_series(1, ${RESOLVED}) i
     ON CONFLICT DO NOTHING`,
  );
  // The pending slice: a few seconds' worth of commits, plus stragglers whose
  // transaction never appeared and which expiry will take in 24 hours.
  await admin.query(
    `INSERT INTO social_intents (tx_digest, account_id, action, presale_id, source_entry_id, why_text, registered_at)
     SELECT ${digest(`${RESOLVED} + i`)}, ${account(`1 + i % ${ACCOUNTS}`)}, 'commit', '0x' || lpad('5a1e' || to_hex(i % 60), 64, '0'),
       CASE WHEN i % 2 = 0 THEN 'a:' || (100000 + (i % 20000) * 37) || ':0:0:0' END,
       CASE WHEN i % 3 = 0 THEN 'Pending reason ' || i END,
       now() - ((i * 37) || ' seconds')::interval
     FROM generate_series(1, ${PENDING}) i
     ON CONFLICT DO NOTHING`,
  );
  // 300k attributions over 20k posts: what the panel's "blasted too" counts read.
  await admin.query(
    `INSERT INTO social_attributions
       (tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id, quote_amount, usd_value, occurred_at_ms)
     SELECT ${digest(`${RESOLVED} + ${PENDING} + i`)}, 'a:' || (100000 + (i % 20000) * 37) || ':0:0:0',
       CASE WHEN i % 5 > 0 THEN ${account(`1 + i % ${ACCOUNTS}`)} END,
       ${account(`1 + (i * 7) % ${ACCOUNTS}`)}, 'commit', '0x' || lpad('5a1e' || to_hex(i % 60), 64, '0'),
       50000000, 50, (extract(epoch FROM now()) * 1000)::bigint - i * 1000
     FROM generate_series(1, ${ATTRIBUTIONS}) i
     ON CONFLICT DO NOTHING`,
  );
  // The resolvable part of the pending slice: the newest `BATCH` commits of
  // the 1M activity rows become the transactions behind the oldest pending
  // intents, so the worker's batch join finds exactly a full batch and skips
  // the rest. Matching the intents to the rows is cheaper than the other way
  // round, and a digest is not referenced by anything.
  await admin.query(
    `WITH recent AS (
       SELECT digest, row_number() OVER () AS n
       FROM (SELECT digest FROM blast_infra_fixture.activity WHERE kind = 'presale_commit' ORDER BY timestamp_ms DESC LIMIT ${BATCH}) r
     ), pend AS (
       SELECT tx_digest, row_number() OVER () AS n
       FROM (SELECT tx_digest FROM social_intents WHERE status = 'pending' ORDER BY registered_at LIMIT ${BATCH}) p
     )
     UPDATE social_intents i SET tx_digest = recent.digest
     FROM pend JOIN recent USING (n)
     WHERE i.tx_digest = pend.tx_digest`,
  );
  await admin.query("CREATE INDEX IF NOT EXISTS activity_digest ON blast_infra_fixture.activity (digest)");
  // R3-27: every registration also logged its commit (key `commit:<digest>`).
  // A resolved one has been settled; a pending one is still `submitted`. A
  // digest the log's CHECK would refuse (the fixture's activity digests are
  // not all base58) is logged without one, as a pre-digest row would be.
  await admin.query(
    `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, quote_type, quote_amount, usd_value,
       idempotency_key, created_at_ms, settled_at_ms, failure_code)
     SELECT gen_random_uuid(), i.account_id, 'commit',
       CASE WHEN i.status = 'pending' OR NOT ok THEN 'submitted' WHEN i.status = 'rejected_sender' THEN 'failed' ELSE 'confirmed' END,
       CASE WHEN ok THEN i.tx_digest END, i.presale_id, '0x' || lpad('dba3', 64, '0') || '::usdc::USDC', 50000000, 50,
       'commit:' || i.tx_digest, (extract(epoch FROM i.registered_at) * 1000)::bigint,
       CASE WHEN i.status = 'pending' OR NOT ok THEN NULL ELSE (extract(epoch FROM i.registered_at) * 1000)::bigint + 1000 END,
       CASE WHEN ok AND i.status = 'rejected_sender' THEN 'mismatch' END
     FROM social_intents i CROSS JOIN LATERAL (SELECT i.tx_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' AS ok) d
     ON CONFLICT DO NOTHING`,
  );
  await admin.query("ANALYZE social_intents; ANALYZE social_attributions; ANALYZE social_transactions; ANALYZE blast_infra_fixture.activity");
  console.log((await admin.query(
    `SELECT (SELECT count(*) FROM social_intents) intents,
       (SELECT count(*) FROM social_intents WHERE status = 'pending') pending,
       (SELECT count(*) FROM social_attributions) attributions,
       (SELECT count(*) FROM social_transactions) logged,
       (SELECT count(*) FROM social_intents i JOIN chain_read_v1.activity a ON a.digest = i.tx_digest AND a.kind = 'presale_commit'
        WHERE i.status = 'pending') resolvable`,
  )).rows[0]);
  await admin.end();
}

type Timing = { label: string; p50: number; p95: number; max: number; runs: number };

async function time(label: string, runs: number, run: (i: number) => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < runs + 3; i += 1) {
    const start = performance.now();
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Measure benchmark cases and warm-up samples serially; overlapping queries would contaminate their latency.
    await run(i);
    if (i >= 3) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => +samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!.toFixed(1);
  const result = { label, p50: at(0.5), p95: at(0.95), max: +samples.at(-1)!.toFixed(1), runs };
  console.log(JSON.stringify(result));
  return result;
}

type Client = pg.PoolClient;
const reader = (client: Client): ReadableDatabase =>
  ({ read: (text: string, values?: readonly unknown[]) => client.query(text, values as unknown[]) }) as unknown as ReadableDatabase;

async function rolledBack(pool: pg.Pool, body: (client: Client) => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await body(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function bench() {
  const owner = new pg.Pool({ connectionString: URL_, max: 2 });
  const web = new pg.Pool({ connectionString: urlAs(URL_, "blast_web"), max: 2 });
  const watcher = new pg.Pool({ connectionString: urlAs(URL_, "blast_watcher"), max: 2 });
  const timings: Timing[] = [];
  const plans: Record<string, string> = {};
  const explain = async (label: string, pool: pg.Pool, text: string, values: unknown[]) => {
    await rolledBack(pool, async (client) => {
      const plan = await client.query<{ "QUERY PLAN": string }>(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, values);
      plans[label] = plan.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  };

  const visible = (await owner.query<{ entry_id: string }>(
    `SELECT 'a:' || a.activity_id AS entry_id
     FROM chain_read_v1.activity a JOIN social_account_wallets w ON w.address = a.actor
     JOIN social_accounts s ON s.account_id = w.account_id AND s.privacy = 'public' AND s.sharing_since IS NOT NULL
     WHERE a.kind = 'presale_commit' ORDER BY a.timestamp_ms DESC LIMIT 1`,
  )).rows[0]!.entry_id;
  const caller = (await owner.query<{ account_id: string }>("SELECT account_id::text FROM social_accounts LIMIT 1")).rows[0]!.account_id;
  const presale = (await owner.query<{ presale_id: string }>("SELECT presale_id FROM chain_read_v1.presales LIMIT 1")).rows[0]!.presale_id;
  const checkpoint = (await owner.query<{ c: string }>("SELECT presale_checkpoint::text AS c FROM chain_read_v1.watermark")).rows[0]!.c;
  const resolvable = (await owner.query<{ tx_digest: string; actor: string; timestamp_ms: string; account_id: string }>(
    `SELECT i.tx_digest, a.actor, a.timestamp_ms::text, i.account_id::text
     FROM social_intents i JOIN chain_read_v1.activity a ON a.digest = i.tx_digest AND a.kind = 'presale_commit'
     WHERE i.status = 'pending' LIMIT 1`,
  )).rows[0]!;
  const post = (await owner.query<{ entry_id: string }>(
    "SELECT entry_id FROM social_attributions GROUP BY entry_id ORDER BY count(*) DESC LIMIT 1",
  )).rows[0]!.entry_id;
  const fresh = "LsFfffffffffffffffffffffffffffffffffffffffff";

  // T-024: the route's whole transaction (the digest's owner, the source's
  // visibility, the insert) as the web runtime runs it.
  timings.push(await time("T-024 POST /api/social/intents transaction (owner + isVisible + insert, blast_web)", 50, (i) =>
    rolledBack(web, async (client) => {
      await client.query(INTENT_OWNER_SQL, [fresh]);
      await isVisible(reader(client), visible, THRESHOLDS);
      await client.query(INTENT_INSERT_SQL, [`${fresh.slice(0, 40)}${String(i).padStart(4, "2")}`, caller, "commit", presale, visible, "Scale why"]);
    })));
  // And the retry a 3 s timeout produces: one primary-key read, nothing written.
  timings.push(await time("T-024 a retried registration (the digest's owner, blast_web)", 50, () =>
    web.query(INTENT_OWNER_SQL, [resolvable.tx_digest])));
  await explain("T-024 the digest's owner", web, INTENT_OWNER_SQL, [resolvable.tx_digest]);
  await explain("T-024 the registration", web, INTENT_INSERT_SQL, [fresh, caller, "commit", presale, visible, "Scale why"]);

  // T-026: the step's batch, over 2,000 pending rows beside 500k resolved ones.
  timings.push(await time("T-026 the step's batch (pending joined to activity by digest, blast_watcher)", 30, () =>
    watcher.query(INTENT_STATEMENTS.batch, [checkpoint, "presale_commit", BATCH])));
  await explain("T-026 the step's batch", watcher, INTENT_STATEMENTS.batch, [checkpoint, "presale_commit", BATCH]);
  timings.push(await time("T-026 the sender check (social_wallet_owners, blast_watcher)", 50, () =>
    watcher.query(INTENT_STATEMENTS.sender, [resolvable.actor, caller, resolvable.timestamp_ms])));
  await explain("T-026 the sender check", watcher, INTENT_STATEMENTS.sender, [resolvable.actor, caller, resolvable.timestamp_ms]);
  timings.push(await time("T-026 the source post (an activity entry, blast_watcher)", 50, () =>
    watcher.query(INTENT_STATEMENTS.sourceActivity, [post, post.slice(2)])));
  await explain("T-026 the source post", watcher, INTENT_STATEMENTS.sourceActivity, [post, post.slice(2)]);

  // The whole resolution of one intent, as the step runs it in one transaction.
  timings.push(await time("T-026 one intent resolved (sender + source + attribution + status, blast_watcher)", 50, (i) =>
    rolledBack(watcher, async (client) => {
      await client.query(INTENT_STATEMENTS.sender, [resolvable.actor, caller, resolvable.timestamp_ms]);
      await client.query(INTENT_STATEMENTS.sourceActivity, [post, post.slice(2)]);
      await client.query(INTENT_STATEMENTS.attribution, [
        `${fresh.slice(0, 40)}${String(i).padStart(4, "3")}`, post, caller, caller, "commit", presale, "50000000", "50", Date.now(),
      ]);
      await client.query(INTENT_STATEMENTS.apply, [resolvable.tx_digest, "applied"]);
    })));
  await explain("T-026 one attribution", watcher, INTENT_STATEMENTS.attribution, [
    fresh, post, caller, caller, "commit", presale, "50000000", "50", Date.now(),
  ]);
  await explain("T-026 the status write", watcher, INTENT_STATEMENTS.apply, [resolvable.tx_digest, "applied"]);

  // Expiry: the sweep that deletes the stragglers, over the same slice.
  const cutoff = Date.now() - 24 * 3_600_000;
  timings.push(await time("T-026 the expiry sweep (24 h of pending, blast_watcher)", 30, () =>
    rolledBack(watcher, (client) => client.query(INTENT_STATEMENTS.expire, [cutoff]))));
  await explain("T-026 the expiry sweep", watcher, INTENT_STATEMENTS.expire, [cutoff]);

  // R3-27 with migration 0085: the worker settles the account's logged commit
  // (by the log's `(account_id, idempotency_key)` key), and expiry settles the
  // expiring ones before it deletes their intents.
  // The fixture's activity digests are not base58, so the resolvable rows were
  // logged without one; the settlement supplies a valid one (rolled back).
  const settleKey = [resolvable.account_id, `commit:${resolvable.tx_digest}`];
  timings.push(await time("R3-27 settle one logged commit (blast_watcher)", 50, () =>
    rolledBack(watcher, (client) => client.query(SETTLE_LOGGED_SQL, [...settleKey, "confirmed", fresh, null, Date.now()]))));
  await explain("R3-27 settle one logged commit", watcher, SETTLE_LOGGED_SQL, [...settleKey, "confirmed", fresh, null, Date.now()]);
  timings.push(await time("R3-27 settle the expiring commits (blast_watcher)", 30, () =>
    rolledBack(watcher, (client) => client.query(INTENT_STATEMENTS.expireLog, [cutoff, Date.now()]))));
  await explain("R3-27 settle the expiring commits", watcher, INTENT_STATEMENTS.expireLog, [cutoff, Date.now()]);

  fs.mkdirSync("loadtest/results", { recursive: true });
  fs.writeFileSync("loadtest/results/social-intents-timings.json", JSON.stringify(timings, null, 1));
  fs.writeFileSync("loadtest/results/social-intents-plans.txt", Object.entries(plans).map(([k, v]) => `### ${k}\n${v}`).join("\n\n"));
  await owner.end();
  await web.end();
  await watcher.end();
}

if (process.argv[2] === "seed") await seed();
else await bench();
