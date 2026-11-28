import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Pool, PoolClient } from "pg";

import {
  CHAIN_READ_ROWS,
  FIXTURE_CANCELLED_PRESALE_ID,
  FIXTURE_PRESALE_ID,
  FIXTURE_SALE_COIN_TYPE,
  FIXTURE_WALLETS,
  rebuildChainRead,
  seedChainRead,
} from "../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { CHAIN_READ_VIEWS, TABLE_OWNERSHIP } from "@blast/core/modules/database/modules.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE, CHAIN_FIXTURE_VIEWS, resetSharedDatabase, urlAs, type Role } from "../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../core/test/fixtures/modules/database/template.ts";
import { activityEntryId, lifecycleEntryId, milestoneEntryId } from "@blast/core/modules/social/contracts/feed-entries.ts";
import { PORTFOLIO_TREND_STATEMENTS } from "@blast/server/modules/social/portfolio/trend.ts";
import { SETTLE_LOGGED_SQL } from "@blast/core/modules/social/transactions/log.ts";

/**
 * Social feed T-001: the social schema (migrations 0054 to 0100) on a disposable
 * database with blast-infra's fixture `chain_read_v1`: the cross-table
 * callsign guard, `social_wallet_owners`, `social_feed_entries`, the runtime
 * roles' grants and the migrations' reversibility.
 */
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const MIGRATIONS = new URL("../../../../core/src/modules/database/migrations/", import.meta.url);
const RUNTIME_ROLES = ["blast_web", "blast_watcher", "blast_replica", "blast_social"] as const satisfies readonly Role[];

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function wallet(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

/** A migrated database of the test's own whose chain_read_v1 holds the recorded rows. */
async function freshDatabase(): Promise<{ admin: Pool; url: string; drop(): Promise<void> }> {
  const { url, drop } = await freshTestDatabase();
  const admin = createPool(url, { max: 6 });
  await rebuildChainRead(admin);
  return { admin, url, drop };
}

async function insertProfile(db: Pick<Pool, "query">, n: number, callsign: string): Promise<string> {
  const profileId = uuid(n);
  await db.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign,
       disclosure_version, disclosure_accepted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, 'fixture-v1', now())`,
    [profileId, `did:privy:profile-${n}`, `x-${n}`, wallet(0x9000 + n), `wallet-${n}`, callsign],
  );
  return profileId;
}

/** A new member's account: its own callsign and Privy DID. */
async function insertNewAccount(db: Pick<Pool, "query">, n: number, callsign: string): Promise<string> {
  const accountId = uuid(0x1000 + n);
  await db.query(
    "INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES ($1, $2, $3)",
    [accountId, `did:privy:account-${n}`, callsign],
  );
  return accountId;
}

/** A Mission Control member's account: its profile holds the callsign. */
async function insertProfileAccount(db: Pick<Pool, "query">, n: number, profileId: string): Promise<string> {
  const accountId = uuid(0x2000 + n);
  await db.query("INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2)", [accountId, profileId]);
  return accountId;
}

async function rows<T>(db: Pick<Pool, "query">, text: string, values: unknown[] = []): Promise<T[]> {
  return ((await db.query(text, values)) as unknown as { rows: T[] }).rows;
}

/** Resolves once `pid` is waiting on a lock. */
async function waitingOnLock(admin: Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await rows<{ wait_event_type: string | null }>(
      admin,
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (row?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`backend ${pid} never waited on the callsign lock`);
}

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
}

test("T-001-AC-1: one callsign namespace across profiles and social accounts, under concurrency", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    await insertNewAccount(admin, 1, "pilot_one");
    await assert.rejects(insertProfile(admin, 1, "pilot_one"), {
      code: "23505",
      constraint: "mission_control_profiles_callsign_taken",
    });
    await insertProfile(admin, 2, "pilot_two");
    await assert.rejects(insertNewAccount(admin, 2, "pilot_two"), {
      code: "23505",
      constraint: "social_accounts_callsign_taken",
    });
    // The reserved list binds social accounts as it binds profiles.
    await assert.rejects(insertNewAccount(admin, 3, "wallet"), {
      code: "23514",
      constraint: "social_accounts_callsign_not_reserved",
    });
    await assert.rejects(insertProfile(admin, 3, "wallet"), {
      code: "23514",
      constraint: "mission_control_profiles_callsign_not_reserved",
    });
    // A profile-backed account holds no callsign of its own; a new account must.
    const profile = await insertProfile(admin, 4, "pilot_four");
    await insertProfileAccount(admin, 4, profile);
    await assert.rejects(
      admin.query("INSERT INTO social_accounts (account_id, privy_did) VALUES ($1, 'did:privy:no-callsign')", [uuid(0x3000)]),
      { code: "23514", constraint: "social_accounts_profile_or_callsign" },
    );
    await assert.rejects(
      admin.query("INSERT INTO social_accounts (account_id, callsign) VALUES ($1, 'no_did')", [uuid(0x3001)]),
      { code: "23514", constraint: "social_accounts_new_account_identity" },
    );
    // 0058 (OA-16): a wallet-only account holds a Sui address instead of a Privy DID; one account per address.
    await admin.query("INSERT INTO social_accounts (account_id, sui_address, callsign) VALUES ($1, $2, 'wallet_only')", [uuid(0x3002), wallet(0x3002)]);
    await assert.rejects(
      admin.query("INSERT INTO social_accounts (account_id, sui_address, callsign) VALUES ($1, $2, 'wallet_twice')", [uuid(0x3003), wallet(0x3002)]),
      { code: "23505", constraint: "social_accounts_sui_address_key" },
    );
    await assert.rejects(
      admin.query("INSERT INTO social_accounts (account_id, sui_address, callsign) VALUES ($1, '0xABC', 'wallet_bad')", [uuid(0x3004)]),
      { code: "23514", constraint: "social_accounts_sui_address_format" },
    );
    // The callsign guard covers wallet-only accounts too.
    await assert.rejects(insertProfile(admin, 5, "wallet_only"), { code: "23505", constraint: "mission_control_profiles_callsign_taken" });

    // A writer that holds a transaction snapshot could miss the other table's commit: refused.
    const snapshot = await admin.connect();
    try {
      await snapshot.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      await assert.rejects(insertNewAccount(snapshot, 5, "pilot_five"), { code: "55000" });
    } finally {
      await snapshot.query("ROLLBACK");
      snapshot.release();
    }

    // The second writer waits on the first's callsign lock, then sees its commit: both directions.
    for (const [first, second, constraint] of [
      [(db: PoolClient) => insertProfile(db, 6, "racer_six"), (db: PoolClient) => insertNewAccount(db, 6, "racer_six"), "social_accounts_callsign_taken"],
      [(db: PoolClient) => insertNewAccount(db, 7, "racer_seven"), (db: PoolClient) => insertProfile(db, 7, "racer_seven"), "mission_control_profiles_callsign_taken"],
    ] as const) {
      const a = await admin.connect();
      const b = await admin.connect();
      try {
        await a.query("BEGIN");
        await first(a);
        await b.query("BEGIN");
        const pid = await backendPid(b);
        const blocked = second(b);
        blocked.catch(() => undefined);
        await waitingOnLock(admin, pid);
        await a.query("COMMIT");
        await assert.rejects(blocked, { code: "23505", constraint });
      } finally {
        await b.query("ROLLBACK");
        a.release();
        b.release();
      }
    }

    // Unordered races: every pair leaves exactly one holder.
    for (let n = 10; n < 40; n += 1) {
      const callsign = `race_${n}`;
      const outcomes = await Promise.allSettled([insertProfile(admin, n, callsign), insertNewAccount(admin, n, callsign)]);
      assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1, callsign);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") assert.equal((outcome.reason as { code?: string }).code, "23505", callsign);
      }
      const [held] = await rows<{ n: number }>(
        admin,
        `SELECT (SELECT count(*) FROM mission_control_profiles WHERE callsign = $1)
              + (SELECT count(*) FROM social_accounts WHERE callsign = $1) AS n`,
        [callsign],
      );
      assert.equal(Number(held.n), 1, callsign);
    }
  } finally {
    await admin.end();
    await drop();
  }
});

test("T-001-AC-2: social_wallet_owners keeps an address's earliest link and drops an address two accounts claim", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const profile = await insertProfile(admin, 1, "member_one");
    const member = await insertProfileAccount(admin, 1, profile);
    const newcomer = await insertNewAccount(admin, 2, "newcomer_two");
    const t = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 0, minutes)).toISOString();
    const linked = wallet(0xa1);
    const embeddedOwn = wallet(0xa2);
    const embeddedProfile = wallet(0xa3);
    const contested = wallet(0xa4);

    // The member: a Mission Control wallet it also proved earlier as a social wallet (one row, earliest link).
    await admin.query(
      `INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, verified_at)
       VALUES ($1, $2, 'slush', $3, 'ref-linked', $4), ($5, $2, 'embedded', $6, 'ref-contested', $7)`,
      [uuid(0xb1), profile, linked, t(20), uuid(0xb2), contested, t(5)],
    );
    await admin.query(
      "INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $5, $8)",
      [linked, member, t(10), embeddedOwn, newcomer, t(40), contested, t(6)],
    );
    // The member's embedded wallet through its profile's Privy identity; the newcomer's through its own DID.
    await admin.query(
      `INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at)
       VALUES ($1, 'privy', 'did:privy:profile-1', now())
       ON CONFLICT (profile_id, provider) DO NOTHING`,
      [profile],
    );
    const [identity] = await rows<{ provider_subject: string }>(
      admin,
      "SELECT provider_subject FROM mission_control_account_identities WHERE profile_id = $1 AND provider = 'privy'",
      [profile],
    );
    await admin.query(
      "INSERT INTO presale_embedded_wallets (privy_did, address, resolved_at) VALUES ($1, $2, $3), ($4, $5, $6)",
      [identity.provider_subject, embeddedProfile, t(30), "did:privy:account-2", embeddedOwn, t(35)],
    );

    const owners = await rows<{ address: string; account_id: string; linked_at: Date; source: string }>(
      admin,
      "SELECT address, account_id, linked_at, source FROM social_wallet_owners ORDER BY address",
    );
    assert.deepEqual(
      owners.map((row) => ({ ...row, linked_at: row.linked_at.toISOString() })),
      [
        { address: linked, account_id: member, linked_at: t(10), source: "social" },
        { address: embeddedOwn, account_id: newcomer, linked_at: t(35), source: "presale_embedded" },
        { address: embeddedProfile, account_id: member, linked_at: t(30), source: "presale_embedded" },
      ],
      "the contested address belongs to neither account",
    );
    assert.deepEqual(await rows(admin, "SELECT * FROM social_wallet_owners WHERE address = $1", [contested]), []);
  } finally {
    await admin.end();
    await drop();
  }
});

test("T-001-AC-3: social_feed_entries derives every id from chain identity, unchanged by a rebuild", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    await admin.query(
      `INSERT INTO social_milestones (entry_id, presale_id, coin_type, kind, value, activity_id, digest, timestamp_ms)
       VALUES ($1, $2, $3, 'participants', 2, '1001:0:0:0', $4, 1790000101000)`,
      [milestoneEntryId(FIXTURE_PRESALE_ID, "participants", "2"), FIXTURE_PRESALE_ID, FIXTURE_SALE_COIN_TYPE, "Act1001".padEnd(44, "1")],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms)
         VALUES ('m:anything', $1, 'raise', 10, 1)`,
        [FIXTURE_PRESALE_ID],
      ),
      { code: "23514", constraint: "social_milestones_entry_id" },
    );

    const read = () => rows<Record<string, unknown>>(admin, "SELECT * FROM social_feed_entries ORDER BY occurred_at_ms, entry_id");
    const entries = await read();
    assert.deepEqual(
      entries.map(({ entry_id, source, kind, actor }) => ({ entry_id, source, kind, actor })),
      [
        { entry_id: lifecycleEntryId(FIXTURE_PRESALE_ID, "opened"), source: "lifecycle", kind: "presale_opened", actor: null },
        { entry_id: lifecycleEntryId(FIXTURE_CANCELLED_PRESALE_ID, "opened"), source: "lifecycle", kind: "presale_opened", actor: null },
        { entry_id: activityEntryId("1000:0:0:0"), source: "activity", kind: "presale_commit", actor: FIXTURE_WALLETS.alice },
        { entry_id: activityEntryId("1001:0:0:0"), source: "activity", kind: "presale_commit", actor: FIXTURE_WALLETS.bob },
        { entry_id: milestoneEntryId(FIXTURE_PRESALE_ID, "participants", "2"), source: "milestone", kind: "milestone_participants", actor: null },
        { entry_id: activityEntryId("1002:0:0:0"), source: "activity", kind: "presale_commit", actor: FIXTURE_WALLETS.alice },
        { entry_id: lifecycleEntryId(FIXTURE_PRESALE_ID, "funded"), source: "lifecycle", kind: "presale_funded", actor: null },
        { entry_id: lifecycleEntryId(FIXTURE_CANCELLED_PRESALE_ID, "cancelled"), source: "lifecycle", kind: "presale_cancelled", actor: null },
        { entry_id: activityEntryId("1100:0:0:0"), source: "activity", kind: "presale_claim", actor: FIXTURE_WALLETS.alice },
        { entry_id: lifecycleEntryId(FIXTURE_PRESALE_ID, "migrated"), source: "lifecycle", kind: "presale_migrated", actor: null },
        { entry_id: activityEntryId("1200:0:0:0"), source: "activity", kind: "trade_buy", actor: FIXTURE_WALLETS.carol },
        { entry_id: activityEntryId("1201:3:1:0"), source: "activity", kind: "trade_sell", actor: FIXTURE_WALLETS.bob },
        { entry_id: activityEntryId("1201:3:1:1"), source: "activity", kind: "trade_sell", actor: FIXTURE_WALLETS.bob },
      ],
    );
    assert.deepEqual(entries[2], {
      entry_id: "a:1000:0:0:0", source: "activity", kind: "presale_commit", product: "presale",
      occurred_at_ms: "1790000100000", actor: FIXTURE_WALLETS.alice, presale_id: FIXTURE_PRESALE_ID,
      coin_type: FIXTURE_SALE_COIN_TYPE, digest: "Act1000".padEnd(44, "1"), activity_id: "1000:0:0:0",
      quote_type: CHAIN_READ_ROWS.activity[0].quote_type, quote_amount: "5000000000", coin_amount: null,
      quote_refund: null, usd_value: "17.50", usd_price_as_of_ms: "1790000099000", milestone_value: null,
    });
    assert.equal(entries[4].milestone_value, "2");

    // An indexer rebuild reloads the same chain rows: every entry, id included, is unchanged.
    await rebuildChainRead(admin);
    assert.deepEqual(await read(), entries);

    // Kinds are open: a kind blast-infra adds later appears unchanged.
    await seedChainRead(admin, {
      activity: [{
        ...CHAIN_READ_ROWS.activity[4], checkpoint: 1_300, kind: "boost_mint", product: "boosts", presale_id: null,
      }],
    });
    const [boost] = await rows<{ kind: string; source: string }>(
      admin,
      "SELECT kind, source FROM social_feed_entries WHERE entry_id = 'a:1300:0:0:0'",
    );
    assert.deepEqual(boost, { kind: "boost_mint", source: "activity" });
  } finally {
    await admin.end();
    await drop();
  }
});

test("T-001-AC-4: the web runtime inserts and updates a why but never deletes one", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const client = await admin.connect();
  try {
    const author = await insertNewAccount(admin, 1, "author_one");
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE blast_web");
    await client.query(
      "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, 'a:1000:0:0:0', $2, 'early and convinced')",
      [uuid(0xc1), author],
    );
    const updated = await client.query(
      "UPDATE social_whys SET state = 'deleted', deleted_at = now() WHERE why_id = $1",
      [uuid(0xc1)],
    );
    assert.equal(updated.rowCount, 1);
    await assert.rejects(client.query("DELETE FROM social_whys WHERE why_id = $1", [uuid(0xc1)]), { code: "42501" });
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await admin.end();
    await drop();
  }
});

test("T-021 (0079): a why is never edited and moves only active→deleted|removed and removed→active; an item's records are indexed", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const client = await admin.connect();
  try {
    const author = await insertNewAccount(admin, 1, "author_one");
    const insert = (n: number) =>
      admin.query(
        "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, 'a:1000:0:0:0', $2, 'early')",
        [uuid(0xd0 + n), author],
      );
    await insert(1);
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE blast_web");
    await assert.rejects(client.query("UPDATE social_whys SET text = 'edited' WHERE why_id = $1", [uuid(0xd1)]), {
      code: "23514",
      constraint: "social_whys_never_edited",
    });
    await client.query("ROLLBACK");
    // The owner (the operator CLI) removes and restores; nobody revives a deleted why.
    await admin.query("UPDATE social_whys SET state = 'removed', removed_at = now(), removed_by = 'ops', removal_reason = 'spam' WHERE why_id = $1", [uuid(0xd1)]);
    await admin.query("UPDATE social_whys SET state = 'active', removed_at = NULL, removed_by = NULL, removal_reason = NULL WHERE why_id = $1", [uuid(0xd1)]);
    await admin.query("UPDATE social_whys SET state = 'deleted', deleted_at = now() WHERE why_id = $1", [uuid(0xd1)]);
    for (const write of [
      "UPDATE social_whys SET state = 'active', deleted_at = NULL WHERE why_id = $1",
      "UPDATE social_whys SET state = 'removed', deleted_at = NULL, removed_at = now(), removed_by = 'ops' WHERE why_id = $1",
      "UPDATE social_whys SET entry_id = 'a:1001:0:0:0' WHERE why_id = $1",
    ]) {
      await assert.rejects(admin.query(write, [uuid(0xd1)]), { code: "23514" }, write);
    }
    const indexes = await rows<{ indexname: string }>(admin, "SELECT indexname FROM pg_indexes WHERE tablename = 'social_whys' ORDER BY 1");
    assert.ok(indexes.some((row) => row.indexname === "social_whys_entry_idx"));
  } finally {
    client.release();
    await admin.end();
    await drop();
  }
});

test("T-024/T-026 (0081): the pending intents have their own access path, and every status a worker writes is allowed", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const account = await insertNewAccount(admin, 81, "intent_one");
    const presale = `0x${"ab".repeat(32)}`;
    const digest = (n: number) => `Fs${n}`.padEnd(44, "2");
    const insert = (n: number, minutesAgo: number) =>
      admin.query(
        `INSERT INTO social_intents (tx_digest, account_id, action, presale_id, why_text, registered_at)
         VALUES ($1, $2, 'commit', $3, 'why ' || $1, now() - ($4::text || ' minutes')::interval)`,
        [digest(n), account, presale, String(minutesAgo)],
      );
    for (let n = 0; n < 5; n += 1) await insert(n, n);

    // 0081: the step's own path — the pending rows only, in the order it pages.
    const indexes = await rows<{ indexname: string; indexdef: string }>(
      admin,
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'social_intents' ORDER BY 1",
    );
    const names = indexes.map((row) => row.indexname);
    assert.deepEqual(names, ["social_intents_account_idx", "social_intents_pending_idx", "social_intents_pkey"]);
    const pending = indexes.find((row) => row.indexname === "social_intents_pending_idx");
    assert.match(pending!.indexdef, /\(registered_at, tx_digest\) WHERE \(status = 'pending'::text\)/);

    // The partial index holds one entry per unresolved intent and loses it on resolution.
    const entries = async () => {
      const [row] = await rows<{ n: string }>(
        admin,
        "SELECT count(*)::text AS n FROM social_intents WHERE status = 'pending'",
      );
      return row!.n;
    };
    assert.equal(await entries(), "5");

    // Every status the worker moves a row to is allowed, and each needs its time.
    for (const [n, status] of [[0, "applied"], [1, "late"], [2, "rejected_sender"]] as const) {
      await admin.query("UPDATE social_intents SET status = $2, resolved_at = now() WHERE tx_digest = $1", [digest(n), status]);
    }
    assert.equal(await entries(), "2");
    await assert.rejects(admin.query("UPDATE social_intents SET status = 'applied' WHERE tx_digest = $1", [digest(3)]), { code: "23514" });
    await assert.rejects(admin.query("UPDATE social_intents SET status = 'voided', resolved_at = now() WHERE tx_digest = $1", [digest(3)]), { code: "23514" });

    // 0054's grants, unchanged by 0081: the web registers and the watcher resolves and expires.
    const client = await admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE blast_web");
      // The web never deletes an intent: expiry is the watcher's.
      await assert.rejects(client.query("DELETE FROM social_intents WHERE tx_digest = $1", [digest(3)]), { code: "42501" });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE blast_watcher");
      await client.query("DELETE FROM social_intents WHERE status = 'pending' AND registered_at < now() - interval '24 hours'");
      // And the watcher writes the why the resolution attaches.
      await client.query(
        "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, 'a:1000:0:0:0', $2, 'from an intent')",
        [uuid(0x81), account],
      );
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // Down and up again, with the indexes back.
    await admin.query(await readFile(new URL("0081_social_intents_resolve.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(
      (await rows<{ indexname: string }>(admin, "SELECT indexname FROM pg_indexes WHERE tablename = 'social_intents' ORDER BY 1")).map((row) => row.indexname),
      ["social_intents_pkey"],
    );
    await admin.query(await readFile(new URL("0081_social_intents_resolve.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(
      (await rows<{ indexname: string }>(admin, "SELECT indexname FROM pg_indexes WHERE tablename = 'social_intents' ORDER BY 1")).map((row) => row.indexname),
      names,
    );
  } finally {
    await admin.end();
    await drop();
  }
});

test("T-022 (0080): the web runtime inserts one report per account per why, and no role rewrites one", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const client = await admin.connect();
  /** Runs `sql` as `blast_web` in its own transaction, so a refusal does not abort the next one. */
  const asWeb = async (sql: string, values: unknown[] = []) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query("SET LOCAL ROLE blast_web");
      return await own.query(sql, values);
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const author = await insertNewAccount(admin, 1, "author_one");
    const reporter = await insertNewAccount(admin, 2, "reporter_one");
    await admin.query(
      "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, 'a:1000:0:0:0', $2, 'early')",
      [uuid(0xe1), author],
    );
    const insert = "INSERT INTO social_why_reports (why_id, reporter_account_id, reason) VALUES ($1, $2, 'spam') ON CONFLICT (why_id, reporter_account_id) DO NOTHING";
    // One report stores a row; the same account's repeat stores nothing (its primary key).
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE blast_web");
    assert.equal((await client.query(insert, [uuid(0xe1), reporter])).rowCount, 1);
    assert.equal((await client.query(insert, [uuid(0xe1), reporter])).rowCount, 0);
    await client.query("ROLLBACK");

    // 0080: the web runtime keeps INSERT and has neither UPDATE nor DELETE on a report.
    for (const write of [
      "UPDATE social_why_reports SET reason = 'other' WHERE why_id = $1",
      "DELETE FROM social_why_reports WHERE why_id = $1",
    ]) {
      await assert.rejects(asWeb(write, [uuid(0xe1)]), { code: "42501" }, write);
    }

    // And the owner (the operator CLI) does not rewrite what a report says either.
    await admin.query(insert, [uuid(0xe1), reporter]);
    for (const write of [
      "UPDATE social_why_reports SET reason = 'other' WHERE why_id = $1",
      "UPDATE social_why_reports SET created_at = now() + interval '1 day' WHERE why_id = $1",
      "UPDATE social_why_reports SET reason = NULL WHERE why_id = $1",
    ]) {
      await assert.rejects(admin.query(write, [uuid(0xe1)]), { code: "23514", constraint: "social_why_reports_never_edited" }, write);
    }
    assert.deepEqual(await rows(admin, "SELECT reason FROM social_why_reports WHERE why_id = $1", [uuid(0xe1)]), [{ reason: "spam" }]);
  } finally {
    client.release();
    await admin.end();
    await drop();
  }
});

test("T-001-AC-5: no runtime role, and not the owner, deletes an attribution", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const actor = await insertNewAccount(admin, 1, "actor_one");
    await admin.query(
      `INSERT INTO social_attributions (tx_digest, entry_id, actor_account_id, action, presale_id, quote_amount, occurred_at_ms)
       VALUES ('Attr1', 'a:1000:0:0:0', $1, 'commit', $2, 5000000000, 1790000100000)`,
      [actor, FIXTURE_PRESALE_ID],
    );
    for (const role of RUNTIME_ROLES) {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL ROLE ${role}`);
        await assert.rejects(client.query("DELETE FROM social_attributions WHERE tx_digest = 'Attr1'"), { code: "42501" }, role);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    await assert.rejects(admin.query("DELETE FROM social_attributions WHERE tx_digest = 'Attr1'"), { code: "42501" });
    // An operator voids an attribution instead.
    await admin.query("UPDATE social_attributions SET voided_at = now(), void_reason = 'wash trade' WHERE tx_digest = 'Attr1'");
    assert.equal((await rows(admin, "SELECT 1 FROM social_attributions")).length, 1);
    // The operator log is append-only.
    await admin.query(
      "INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('ops', 'void_attribution', 'Attr1', 'wash trade')",
    );
    await assert.rejects(admin.query("UPDATE social_operator_log SET reason = 'edited'"), { code: "42501" });
    await assert.rejects(admin.query("DELETE FROM social_operator_log"), { code: "42501" });
  } finally {
    await admin.end();
    await drop();
  }
});

test("T-001-AC-6: the replica role reads the feed's joins and writes nothing", { skip }, async () => {
  const { admin, url, drop } = await freshDatabase();
  const replica = createRuntimePool(urlAs(url, "blast_replica"), {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 500,
    max: 1,
    statementTimeoutMs: 2_000,
  }, "blast-replica");
  try {
    const follower = await insertNewAccount(admin, 1, "follower_one");
    const author = await insertNewAccount(admin, 2, "author_two");
    await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, now())", [
      FIXTURE_WALLETS.alice, author,
    ]);
    await admin.query(
      "INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1, 'account', $2, 'user')",
      [follower, author],
    );
    await admin.query(
      "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, 'a:1000:0:0:0', $2, 'conviction')",
      [uuid(0xd1), author],
    );
    await admin.query("INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ('a:1000:0:0:0', $1, 'fire')", [follower]);
    await admin.query(
      `INSERT INTO social_attributions (tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id, quote_amount, occurred_at_ms)
       VALUES ('Attr2', 'a:1000:0:0:0', $1, $2, 'commit', $3, 1, 1790000200000)`,
      [author, follower, FIXTURE_PRESALE_ID],
    );
    await admin.query(
      `INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms)
       VALUES ($1, $2, 'holders', 3, 1790000300000)`,
      [milestoneEntryId(FIXTURE_PRESALE_ID, "holders", "3"), FIXTURE_PRESALE_ID],
    );

    assert.equal((await replica.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const joined = await replica.query(
      `SELECT f.entry_id, a.callsign, w.text AS why, count(DISTINCT r.account_id) AS reactions,
              count(DISTINCT t.tx_digest) AS attributions, count(DISTINCT m.entry_id) AS milestones
       FROM social_feed_entries f
       JOIN social_wallet_owners o ON o.address = f.actor
       JOIN social_accounts a ON a.account_id = o.account_id
       JOIN social_follows fo ON fo.target_kind = 'account' AND fo.target_id = a.account_id::text
       LEFT JOIN social_whys w ON w.entry_id = f.entry_id AND w.state = 'active'
       LEFT JOIN social_reactions r ON r.entry_id = f.entry_id
       LEFT JOIN social_attributions t ON t.entry_id = f.entry_id
       LEFT JOIN social_milestones m ON m.presale_id = f.presale_id
       WHERE fo.follower_account_id = $1
       GROUP BY f.entry_id, a.callsign, w.text
       ORDER BY f.entry_id`,
      [follower],
    );
    assert.deepEqual(joined.rows, [
      { entry_id: "a:1000:0:0:0", callsign: "author_two", why: "conviction", reactions: "1", attributions: "1", milestones: "1" },
      { entry_id: "a:1002:0:0:0", callsign: "author_two", why: null, reactions: "0", attributions: "0", milestones: "0" },
      { entry_id: "a:1100:0:0:0", callsign: "author_two", why: null, reactions: "0", attributions: "0", milestones: "1" },
    ]);
    await replica.query("SELECT count(*) FROM social_config JOIN social_default_accounts ON TRUE");

    for (const write of [
      "INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES (gen_random_uuid(), 'did:privy:replica', 'replica_probe')",
      "UPDATE social_accounts SET display_name = 'x'",
      "DELETE FROM social_accounts",
      "UPDATE social_account_wallets SET kind = kind",
      "DELETE FROM social_follows",
      "UPDATE social_whys SET text = 'edited'",
      "DELETE FROM social_whys",
      "INSERT INTO social_reactions (entry_id, account_id, reaction) SELECT 'a:1:0:0:0', account_id, 'fire' FROM social_accounts LIMIT 1",
      "DELETE FROM social_reactions",
      "UPDATE social_attributions SET voided_at = now()",
      "DELETE FROM social_attributions",
      "INSERT INTO social_milestones (entry_id, presale_id, kind, value, timestamp_ms) VALUES ('m:x', 'x', 'raise', 1, 1)",
      "DELETE FROM social_milestones",
      "UPDATE social_config SET value = value",
      "DELETE FROM social_default_accounts",
      "INSERT INTO social_intents (tx_digest, account_id, action, presale_id) VALUES ('x', gen_random_uuid(), 'commit', 'x')",
    ]) {
      await assert.rejects(replica.query(write), { code: "42501" }, write);
    }
    // The views are not updatable for anyone; the rewriter may refuse before the grant check.
    for (const write of ["DELETE FROM social_feed_entries", "DELETE FROM social_wallet_owners"]) {
      await assert.rejects(replica.query(write), { code: /^(42501|55000)$/ }, write);
    }
  } finally {
    await Promise.all([admin.end(), replica.end()]);
    await drop();
  }
});

test("UI-13: 0064 keeps one notification per recipient and source; only a follow names an actor", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const kai = await insertNewAccount(admin, 64, "notify_kai");
    const mira = await insertNewAccount(admin, 65, "notify_mira");
    const presale = wallet(0x64);
    const insert = (key: string, kind: string, actor: string | null) =>
      admin.query(
        `INSERT INTO social_notifications (account_id, kind, source_key, presale_id, actor_account_id, occurred_at_ms)
         VALUES ($1, $2, $3, $4, $5, 1) ON CONFLICT (account_id, source_key) DO NOTHING`,
        [kai, kind, key, presale, actor],
      );
    assert.equal((await insert("follow:1:2:0:0", "follow", mira)).rowCount, 1);
    assert.equal((await insert("follow:1:2:0:0", "follow", mira)).rowCount, 0, "a rerun inserts nothing");
    await assert.rejects(insert("funded:x", "funded", mira), { code: "23514", constraint: "social_notifications_follow_actor" });
    await assert.rejects(insert("follow:9", "follow", null), { code: "23514", constraint: "social_notifications_follow_actor" });
    await assert.rejects(insert("Bad key", "funded", null), { code: "23514" });
    await assert.rejects(insert("x:1", "mention", null), { code: "23514" });
    const indexes = await rows<{ indexname: string }>(admin, "SELECT indexname FROM pg_indexes WHERE tablename = 'social_notifications' ORDER BY 1");
    assert.deepEqual(indexes.map((row) => row.indexname), [
      "social_notifications_page_idx",
      "social_notifications_pkey",
      "social_notifications_retention_idx",
      "social_notifications_source",
      "social_notifications_unread_idx",
    ]);
  } finally {
    await admin.end();
    await drop();
  }
});

test("UI-20: 0068 keeps an account's drafts as bounded JSON objects, listed by its keyset index", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const kai = await insertNewAccount(admin, 68, "draft_kai");
    const insert = (n: number, body: string, logo: string | null = null, allowlist: string | null = null, version = 1) =>
      admin.query(
        "INSERT INTO social_presale_drafts (draft_id, account_id, version, body, logo_url, allowlist) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb)",
        [uuid(0x6800 + n), kai, version, body, logo, allowlist],
      );
    assert.equal((await insert(1, '{"name":"Meridian"}', "https://blob.example/l.webp", '{"leaf_count":2}')).rowCount, 1);
    await assert.rejects(insert(2, "[]"), { code: "23514" });
    await assert.rejects(insert(3, JSON.stringify({ big: "x".repeat(70_000) })), { code: "23514" });
    await assert.rejects(insert(4, "{}", "http://plain.example/l.png"), { code: "23514" });
    await assert.rejects(insert(5, "{}", null, '"nope"'), { code: "23514" });
    await assert.rejects(insert(6, "{}", null, null, 0), { code: "23514" });
    await assert.rejects(insert(1, "{}"), { code: "23505", constraint: "social_presale_drafts_pkey" });
    await assert.rejects(
      admin.query("INSERT INTO social_presale_drafts (draft_id, account_id, version, body) VALUES ($1, $2, 1, '{}')", [uuid(0x6807), uuid(0x9999)]),
      { code: "23503" },
    );
    const indexes = await rows<{ indexname: string }>(admin, "SELECT indexname FROM pg_indexes WHERE tablename = 'social_presale_drafts' ORDER BY 1");
    // 0091 (R3-25) adds the one-draft-per-sale index.
    assert.deepEqual(indexes.map((row) => row.indexname), ["social_presale_drafts_account_idx", "social_presale_drafts_pkey", "social_presale_drafts_published_idx"]);
  } finally {
    await admin.end();
    await drop();
  }
});

test("R3-25 (0091): a draft's details hold only valid values, one draft per sale, older bodies gain the new fields, and the migration goes down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const kai = await insertNewAccount(admin, 91, "draft_details_kai");
    const insert = (n: number, columns: Record<string, unknown> = {}) => {
      const names = Object.keys(columns);
      return admin.query(
        `INSERT INTO social_presale_drafts (draft_id, account_id, version, body${names.map((name) => `, ${name}`).join("")})
         VALUES ($1, $2, 1, '{}'${names.map((_, index) => `, $${index + 3}`).join("")})`,
        [uuid(0x9100 + n), kai, ...Object.values(columns)],
      );
    };
    const cover = (n: number) => ({ cover_key: `draft-covers/${uuid(0x9100 + n)}/${"c".repeat(64)}.webp`, cover_url: "https://blob.example/c.webp", cover_width: 1536, cover_height: 512 });
    assert.equal((await insert(1, { site: "https://meridian.finance", x_handle: "meridianfx", telegram: "meridianfx", quote_type: "0x2::sui::SUI", ...cover(1) })).rowCount, 1);
    for (const [n, bad] of [
      [2, { site: "meridian.finance" }],
      [3, { docs_url: "https://user@docs.example" }],
      [4, { x_handle: "@meridianfx" }],
      [5, { telegram: "abcd" }],
      [6, { ...cover(6), cover_url: null }],
      [7, { cover_key: "sale-covers/x.webp", cover_url: "https://b/c", cover_width: 1, cover_height: 1 }],
      [8, { published_presale_id: wallet(0x91) }],
      [9, { published_presale_id: "0xnot", published_at: new Date() }],
    ] as const) {
      await assert.rejects(insert(n, bad), { code: "23514" }, JSON.stringify(bad));
    }
    assert.equal((await insert(10, { published_presale_id: wallet(0x91), published_at: new Date() })).rowCount, 1);
    await assert.rejects(insert(11, { published_presale_id: wallet(0x91), published_at: new Date() }), { code: "23505", constraint: "social_presale_drafts_published_idx" });

    // Down: the columns go, and the bodies lose the fields; a body saved before 0091 gains them on the way up.
    await admin.query("BEGIN");
    // 0110's publication view depends on these draft columns.
    await admin.query(await readFile(new URL("0110_social_presale_creation_discovery.down.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0091_social_presale_draft_details.down.sql", MIGRATIONS), "utf8"));
    const columns = await rows<{ column_name: string }>(admin, "SELECT column_name FROM information_schema.columns WHERE table_name = 'social_presale_drafts' AND column_name IN ('site', 'cover_key', 'published_presale_id')");
    assert.deepEqual(columns, []);
    await admin.query("INSERT INTO social_presale_drafts (draft_id, account_id, version, body) VALUES ($1, $2, 1, '{\"name\":\"Old\"}')", [uuid(0x9120), kai]);
    await admin.query(await readFile(new URL("0091_social_presale_draft_details.up.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0110_social_presale_creation_discovery.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await rows(admin, "SELECT body, quote_type, site FROM social_presale_drafts WHERE draft_id = $1", [uuid(0x9120)]), [{
      body: { name: "Old", quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", site: "", x_handle: "", telegram: "", docs_url: "", audit_url: "" },
      quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
      site: null,
    }]);
    await admin.query("ROLLBACK");
  } finally {
    await admin.end();
    await drop();
  }
});

test("UI-14: 0075 records withdrawals once per request id, digest once, pending without one; 0074 lets a sponsored withdraw name no presale", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const kai = await insertNewAccount(admin, 75, "coins_kai");
    const digest = (n: number) => `${"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkL".slice(0, 40)}${String(n).padStart(3, "1")}`;
    const insert = (n: number, overrides: Record<string, unknown> = {}) => {
      const row = { amount: "100000000", status: "pending", digest: null, failure: null, settled_at: null, fee: "sponsored", recipient: wallet(0xa3), ...overrides };
      return admin.query(
        `INSERT INTO social_coin_transfers (request_id, account_id, sender, recipient, coin_type, amount, fee, status, digest, failure, settled_at)
         VALUES ($1, $2, $3, $4, '0x2::sui::SUI', $5::numeric, $6, $7, $8, $9, $10)`,
        [uuid(0x7500 + n), kai, wallet(0x75), row.recipient, row.amount, row.fee, row.status, row.digest, row.failure, row.settled_at],
      );
    };
    assert.equal((await insert(1)).rowCount, 1);
    assert.equal((await insert(2, { status: "submitted", digest: digest(2) })).rowCount, 1);
    assert.equal((await insert(3, { status: "confirmed", digest: digest(3), settled_at: new Date() })).rowCount, 1);
    assert.equal((await insert(4, { status: "failed", digest: digest(4), failure: "mismatch", settled_at: new Date(), fee: "wallet" })).rowCount, 1);
    for (const [n, bad] of [
      [5, { status: "submitted" }],
      [6, { digest: digest(6) }],
      [7, { status: "failed", digest: digest(7), settled_at: new Date() }],
      [8, { status: "confirmed", digest: digest(8) }],
      [9, { amount: "0" }],
      [10, { amount: "18446744073709551616" }],
      [11, { recipient: "0xA3" }],
      [12, { fee: "free" }],
    ] as const) {
      await assert.rejects(insert(n, bad), { code: "23514" }, JSON.stringify(bad));
    }
    await assert.rejects(insert(1), { code: "23505", constraint: "social_coin_transfers_pkey" });
    await assert.rejects(insert(13, { status: "submitted", digest: digest(2) }), { code: "23505", constraint: "social_coin_transfers_digest_key" });
    const indexes = await rows<{ indexname: string }>(admin, "SELECT indexname FROM pg_indexes WHERE tablename = 'social_coin_transfers' ORDER BY 1");
    assert.deepEqual(indexes.map((row) => row.indexname), ["social_coin_transfers_account_idx", "social_coin_transfers_digest_key", "social_coin_transfers_pkey"]);

    // 0074: a withdraw reservation holds no presale; its down refuses while one exists, then rolls back once it is gone.
    const reserve = (intent: string, presaleId: string | null) =>
      admin.query(
        `INSERT INTO presale_sponsor_reservations (privy_did, sender, presale_id, intent, gas_budget, expires_at, pool_deadline)
         VALUES ('did:privy:coins-74', $1, $2, $3, 2000000, now() + interval '2 minutes', now() + interval '5 seconds')`,
        [wallet(0x74), presaleId, intent],
      );
    await reserve("withdraw", null);
    await assert.rejects(reserve("withdraw", wallet(0x51)), { code: "23514", constraint: "presale_sponsor_reservations_presale_by_intent" });
    await assert.rejects(reserve("commit", null), { code: "23514", constraint: "presale_sponsor_reservations_presale_by_intent" });
    await admin.query("BEGIN");
    await assert.rejects(admin.query(await readFile(new URL("0074_presale_sponsor_withdraw.down.sql", MIGRATIONS), "utf8")), /sponsored withdraw reservations exist/);
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM presale_sponsor_reservations WHERE intent = 'withdraw'");
    await admin.query("BEGIN");
    await admin.query(await readFile(new URL("0074_presale_sponsor_withdraw.down.sql", MIGRATIONS), "utf8"));
    await assert.rejects(reserve("withdraw", null), { code: "23502" });
    await admin.query("ROLLBACK");
  } finally {
    await admin.end();
    await drop();
  }
});

test("R3-27 (0084): the transaction log keeps one row per key and digest, moves submitted to confirmed|failed only, and no role edits its facts or deletes one", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  /** Runs `sql` as `blast_web` in its own transaction, so a refusal does not abort the next one. */
  const asWeb = async (sql: string, values: unknown[] = []) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query("SET LOCAL ROLE blast_web");
      return await own.query(sql, values);
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const kai = await insertNewAccount(admin, 84, "log_kai");
    const digest = (n: number) => `${"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkL".slice(0, 40)}${String(n).padStart(3, "1")}`;
    const later = Date.now() + 60_000;
    const insert = (n: number, overrides: Record<string, unknown> = {}) => {
      const row = { kind: "withdraw", state: "submitted", digest: null, failure_code: null, settled_at_ms: null, amount: "100", coin_type: "0x2::sui::SUI", key: `k${n}`, ...overrides };
      return admin.query(
        `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, coin_type, amount, idempotency_key, settled_at_ms, failure_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9, $10)`,
        [uuid(0x8400 + n), kai, row.kind, row.state, row.digest, row.coin_type, row.amount, row.key, row.settled_at_ms, row.failure_code],
      );
    };
    assert.equal((await insert(1)).rowCount, 1);
    assert.equal((await insert(2, { digest: digest(2) })).rowCount, 1);
    assert.equal((await insert(3, { state: "confirmed", digest: digest(3), settled_at_ms: later })).rowCount, 1);
    assert.equal((await insert(4, { state: "failed", failure_code: "rejected", settled_at_ms: later })).rowCount, 1);
    for (const [n, bad] of [
      [5, { kind: "airdrop" }],
      [6, { state: "pending" }],
      [7, { state: "confirmed", settled_at_ms: later }],
      [8, { state: "failed", settled_at_ms: later }],
      [9, { state: "failed", failure_code: "MoveAbort(0x2::coin, 7)", settled_at_ms: later }],
      [10, { state: "confirmed", digest: digest(11) }],
      [11, { settled_at_ms: later }],
      [12, { state: "confirmed", digest: digest(12), settled_at_ms: 1 }],
      [13, { digest: "not-a-digest" }],
      [14, { amount: "-1" }],
      [15, { amount: "18446744073709551616" }],
      [16, { coin_type: null }],
      [17, { key: "" }],
    ] as const) {
      await assert.rejects(insert(n, bad), { code: "23514" }, JSON.stringify(bad));
    }
    await assert.rejects(insert(1, { key: "k-other" }), { code: "23505", constraint: "social_transactions_pkey" });
    await assert.rejects(insert(18, { key: "k1" }), { code: "23505", constraint: "social_transactions_idempotency_key" });
    await assert.rejects(insert(19, { digest: digest(2) }), { code: "23505", constraint: "social_transactions_digest_idx" });
    const indexes = await rows<{ indexname: string; indexdef: string }>(admin, "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'social_transactions' ORDER BY 1");
    assert.deepEqual(indexes.map((row) => row.indexname), [
      // 0096 (R3-63) adds the open claims' partial index; its own test is below.
      "social_transactions_account_idx", "social_transactions_digest_idx", "social_transactions_idempotency_key",
      "social_transactions_open_claims_idx", "social_transactions_open_creator_idx", "social_transactions_open_launch_claims_idx",
      "social_transactions_pkey",
    ]);
    assert.match(indexes[0]!.indexdef, /\(account_id, created_at_ms DESC, tx_id\)$/);
    assert.match(indexes[1]!.indexdef, /UNIQUE INDEX .* \(digest\) WHERE \(digest IS NOT NULL\)$/);

    // The web runtime records progress (a digest, then the outcome; each rolled back here) and has no DELETE.
    assert.equal((await asWeb("UPDATE social_transactions SET digest = $2 WHERE tx_id = $1", [uuid(0x8401), digest(1)])).rowCount, 1);
    assert.equal(
      (await asWeb("UPDATE social_transactions SET state = 'failed', failure_code = 'expired', settled_at_ms = $2 WHERE tx_id = $1", [uuid(0x8401), later])).rowCount,
      1,
    );
    await assert.rejects(asWeb("DELETE FROM social_transactions WHERE tx_id = $1", [uuid(0x8401)]), { code: "42501" });

    // No role, the owner (the operator CLI) included, edits a fact, moves a settled row, or replaces a digest.
    const refusals: readonly (readonly [string, unknown[], string])[] = [
      ["UPDATE social_transactions SET amount = 1 WHERE tx_id = $1", [uuid(0x8401)], "social_transactions_never_edited"],
      ["UPDATE social_transactions SET kind = 'claim_tokens' WHERE tx_id = $1", [uuid(0x8401)], "social_transactions_never_edited"],
      ["UPDATE social_transactions SET account_id = account_id, created_at_ms = created_at_ms + 1 WHERE tx_id = $1", [uuid(0x8401)], "social_transactions_never_edited"],
      ["UPDATE social_transactions SET idempotency_key = 'other' WHERE tx_id = $1", [uuid(0x8401)], "social_transactions_never_edited"],
      ["UPDATE social_transactions SET usd_value = 5 WHERE tx_id = $1", [uuid(0x8401)], "social_transactions_never_edited"],
      ["UPDATE social_transactions SET state = 'submitted', settled_at_ms = NULL WHERE tx_id = $1", [uuid(0x8403)], "social_transactions_settled_final"],
      ["UPDATE social_transactions SET state = 'failed', failure_code = 'mismatch' WHERE tx_id = $1", [uuid(0x8403)], "social_transactions_settled_final"],
      ["UPDATE social_transactions SET failure_code = 'expired' WHERE tx_id = $1", [uuid(0x8404)], "social_transactions_settled_final"],
      ["UPDATE social_transactions SET digest = $2 WHERE tx_id = $1", [uuid(0x8402), digest(21)], "social_transactions_digest_once"],
      ["UPDATE social_transactions SET digest = NULL WHERE tx_id = $1", [uuid(0x8402)], "social_transactions_digest_once"],
    ];
    for (const [sql, values, constraint] of refusals) {
      await assert.rejects(admin.query(sql, values), { code: "23514", constraint }, sql);
      await assert.rejects(asWeb(sql, values), { code: "23514", constraint }, `${sql} as blast_web`);
    }
    // submitted moves to confirmed or failed only, never back, and settles with its time.
    await assert.rejects(admin.query("UPDATE social_transactions SET state = 'confirmed' WHERE tx_id = $1", [uuid(0x8402)]), { code: "23514" });
    assert.equal((await admin.query("UPDATE social_transactions SET state = 'confirmed', settled_at_ms = $2 WHERE tx_id = $1", [uuid(0x8402), later])).rowCount, 1);
    assert.deepEqual(
      await rows(admin, "SELECT tx_id::text AS id, state, failure_code FROM social_transactions ORDER BY tx_id"),
      [
        { id: uuid(0x8401), state: "submitted", failure_code: null },
        { id: uuid(0x8402), state: "confirmed", failure_code: null },
        { id: uuid(0x8403), state: "confirmed", failure_code: null },
        { id: uuid(0x8404), state: "failed", failure_code: "rejected" },
      ],
    );

    // Roll back vesting's dependent table first, then exercise 0084 and restore both.
    await admin.query("BEGIN");
    await admin.query(await readFile(new URL("0120_vesting_sponsorship.down.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0118_utility_vesting.down.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0084_social_transactions.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await rows(admin, "SELECT to_regclass('social_transactions') AS t, to_regproc('social_transactions_check_update') AS f"), [{ t: null, f: null }]);
    await admin.query(await readFile(new URL("0084_social_transactions.up.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0118_utility_vesting.up.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0120_vesting_sponsorship.up.sql", MIGRATIONS), "utf8"));
    await admin.query("ROLLBACK");
  } finally {
    await admin.end();
    await drop();
  }
});

test("R3-24 (0090): a sale's details hold only valid values, its edits are insert-only for every role, and the migration goes down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const as = async (role: string, sql: string, values: unknown[] = []) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query(`SET LOCAL ROLE ${role}`);
      return await own.query(sql, values);
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const sale = wallet(0x9001);
    const insert = (overrides: Record<string, unknown> = {}) => {
      const row = { tagline: "Lending for the long run", site: "https://meridian.finance", x_handle: "meridianfx", telegram: "meridianfx",
        docs_url: "https://docs.meridian.finance/a?b=1", audit_url: null, launch_at_ms: null, cover_key: null, cover_url: null,
        cover_width: null, cover_height: null, account: uuid(0x9002), operator: null, ...overrides };
      return admin.query(
        `INSERT INTO social_sale_metadata (presale_id, tagline, site, x_handle, telegram, docs_url, audit_url, launch_at_ms,
           cover_key, cover_url, cover_width, cover_height, updated_by_account_id, updated_by_operator, updated_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1)`,
        [(overrides.presale_id as string) ?? sale, row.tagline, row.site, row.x_handle, row.telegram, row.docs_url, row.audit_url, row.launch_at_ms,
          row.cover_key, row.cover_url, row.cover_width, row.cover_height, row.account, row.operator],
      );
    };
    const cover = { cover_key: `sale-covers/${sale}/${"a".repeat(64)}.webp`, cover_url: "https://blob.example/c.webp", cover_width: 1536, cover_height: 512 };
    assert.equal((await insert(cover)).rowCount, 1);
    for (const bad of [
      { tagline: "" },
      { tagline: "a".repeat(121) },
      { tagline: "one\ntwo" },
      { site: "http://meridian.finance" },
      { site: "https://user@meridian.finance" },
      { site: "https://meridian.finance:8443" },
      { docs_url: "https://docs.example/a b" },
      { x_handle: "a".repeat(16) },
      { x_handle: "@meridianfx" },
      { telegram: "abcd" },
      { launch_at_ms: 0 },
      { ...cover, cover_url: null },
      { ...cover, cover_key: "elsewhere/x.webp" },
      { account: null },
      { operator: "ops.one" },
      { presale_id: "0xnot" },
    ]) {
      await assert.rejects(insert({ presale_id: wallet(0x9003), ...bad }), { code: "23514" }, JSON.stringify(bad));
    }
    assert.equal((await insert({ presale_id: wallet(0x9004), account: null, operator: "ops.one", ...cover, cover_key: `draft-covers/${uuid(7)}/${"b".repeat(64)}.webp` })).rowCount, 1);

    const edit = (author: { account?: string; operator?: string }) => admin.query(
      "INSERT INTO social_sale_metadata_edits (presale_id, account_id, operator_id, at_ms, before) VALUES ($1, $2, $3, 1, '{}'::jsonb) RETURNING edit_id::text",
      [sale, author.account ?? null, author.operator ?? null],
    );
    const first = (await edit({ account: uuid(0x9002) })).rows[0].edit_id;
    const second = (await edit({ operator: "ops.one" })).rows[0].edit_id;
    assert.ok(Number(second) > Number(first), "edits count in the order they were written");
    await assert.rejects(edit({}), { code: "23514", constraint: "social_sale_metadata_edits_author" });
    await assert.rejects(edit({ account: uuid(1), operator: "ops" }), { code: "23514", constraint: "social_sale_metadata_edits_author" });
    for (const write of ["UPDATE social_sale_metadata_edits SET at_ms = 2", "DELETE FROM social_sale_metadata_edits", "TRUNCATE social_sale_metadata_edits"]) {
      await assert.rejects(admin.query(write), { code: "23514", constraint: "social_sale_metadata_edits_insert_only" }, write);
    }
    // The web runtime writes rows and edits and never deletes either; the replica reads rows, never edits.
    assert.equal((await as("blast_web", "UPDATE social_sale_metadata SET tagline = NULL WHERE presale_id = $1", [sale])).rowCount, 1);
    await assert.rejects(as("blast_web", "DELETE FROM social_sale_metadata"), { code: "42501" });
    await assert.rejects(as("blast_web", "UPDATE social_sale_metadata_edits SET at_ms = 2"), { code: "42501" });
    assert.equal((await as("blast_replica", "SELECT count(*)::int AS n FROM social_sale_metadata")).rows[0].n, 2);
    await assert.rejects(as("blast_replica", "SELECT count(*) FROM social_sale_metadata_edits"), { code: "42501" });
    await assert.rejects(as("blast_watcher", "SELECT count(*) FROM social_sale_metadata"), { code: "42501" });
    const indexes = await rows<{ indexname: string; indexdef: string }>(admin, "SELECT indexname, indexdef FROM pg_indexes WHERE tablename LIKE 'social_sale_metadata%' ORDER BY 1");
    assert.deepEqual(indexes.map((row) => row.indexname), ["social_sale_metadata_edits_pkey", "social_sale_metadata_edits_presale_idx", "social_sale_metadata_pkey"]);
    assert.match(indexes[1]!.indexdef, /\(presale_id, edit_id DESC\)$/);

    // 0090 goes down and up again on its own, and takes its trigger function with it.
    await admin.query("BEGIN");
    await admin.query(await readFile(new URL("0090_social_sale_metadata.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(
      await rows(admin, "SELECT to_regclass('social_sale_metadata') AS t, to_regclass('social_sale_metadata_edits') AS e, to_regproc('social_sale_metadata_edits_refuse') AS f"),
      [{ t: null, e: null, f: null }],
    );
    await admin.query(await readFile(new URL("0090_social_sale_metadata.up.sql", MIGRATIONS), "utf8"));
    await admin.query("ROLLBACK");
  } finally {
    await admin.end();
    await drop();
  }
});

test("T-026 with R3-27 (0085): the watcher settles logged rows and does nothing else; the migration goes down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  /** Runs `sql` as `blast_watcher` in its own transaction, so a refusal does not abort the next one. */
  const asWatcher = async (sql: string, values: unknown[] = []) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query("SET LOCAL ROLE blast_watcher");
      const result = await own.query(sql, values);
      await own.query("COMMIT");
      return result;
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const nova = await insertNewAccount(admin, 85, "log_nova");
    const digest = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkL851";
    await admin.query(
      `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, presale_id, quote_type, quote_amount, idempotency_key)
       VALUES ($1, $2, 'commit', 'submitted', $3, $4, $5, 50000000, 'commit:' || $3)`,
      [uuid(0x8501), nova, digest, `0x${"ab".repeat(32)}`, `0x${"db".repeat(32)}::usdc::USDC`],
    );
    // The watcher reads and settles; the settle statement is the one the worker runs.
    assert.equal((await asWatcher("SELECT count(*) FROM social_transactions")).rows.length, 1);
    const settled = await asWatcher(SETTLE_LOGGED_SQL, [nova, `commit:${digest}`, "confirmed", digest, null, Date.now()]);
    assert.equal(settled.rowCount, 1);
    assert.deepEqual(await rows(admin, "SELECT state FROM social_transactions WHERE tx_id = $1", [uuid(0x8501)]), [{ state: "confirmed" }]);
    // A repeat changes nothing: a settled row is final, and the statement only moves `submitted`.
    assert.equal((await asWatcher(SETTLE_LOGGED_SQL, [nova, `commit:${digest}`, "failed", null, "mismatch", null])).rowCount, 0);
    // It never inserts, deletes or edits a fact (0084's trigger holds for this role too).
    await assert.rejects(
      asWatcher("INSERT INTO social_transactions (tx_id, account_id, kind, idempotency_key) VALUES ($1, $2, 'commit', 'k')", [uuid(0x8502), nova]),
      { code: "42501" },
    );
    await assert.rejects(asWatcher("DELETE FROM social_transactions WHERE tx_id = $1", [uuid(0x8501)]), { code: "42501" });
    await assert.rejects(asWatcher("UPDATE social_transactions SET quote_amount = 1 WHERE tx_id = $1", [uuid(0x8501)]), {
      code: "23514",
      constraint: "social_transactions_never_edited",
    });

    // Down revokes exactly the watcher's two privileges; up gives them back.
    const privileges = async () =>
      (
        await rows<{ p: string }>(
          admin,
          `SELECT privilege_type AS p FROM information_schema.role_table_grants
           WHERE table_name = 'social_transactions' AND grantee = 'blast_watcher' ORDER BY 1`,
        )
      ).map((row) => row.p);
    assert.deepEqual(await privileges(), ["SELECT", "UPDATE"]);
    await admin.query(await readFile(new URL("0085_social_transactions_settle.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await privileges(), []);
    await admin.query(await readFile(new URL("0085_social_transactions_settle.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await privileges(), ["SELECT", "UPDATE"]);
  } finally {
    await admin.end();
    await drop();
  }
});

test("R3-63 (0096): the open claims have their own partial index, which the claim steps' scans use; the migration goes down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const nova = await insertNewAccount(admin, 96, "claim_nova");
    // One open claim, one settled, one open commit: only the first is in the index's predicate.
    for (const [n, kind, state] of [[1, "claim_refund", "submitted"], [2, "claim_tokens", "confirmed"], [3, "commit", "submitted"]] as const) {
      await admin.query(
        `INSERT INTO social_transactions (tx_id, account_id, kind, state, digest, idempotency_key, created_at_ms, settled_at_ms)
         VALUES ($1, $2, $3, $4, $5, $3 || ':' || $6, $7, $8)`,
        [uuid(0x9600 + n), nova, kind, state, `4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bk96${n}`, String(n), 1_790_000_000_000, state === "submitted" ? null : 1_790_000_001_000],
      );
    }
    const definition = await rows<{ indexdef: string }>(admin, "SELECT indexdef FROM pg_indexes WHERE indexname = 'social_transactions_open_claims_idx'");
    assert.equal(definition.length, 1);
    assert.match(definition[0]!.indexdef, /\(created_at_ms, tx_id\) WHERE \(\(state = 'submitted'::text\) AND \(kind = ANY \(ARRAY\['claim_refund'::text, 'claim_tokens'::text, 'claim_vesting'::text\]\)\)\)/);
    await admin.query(await readFile(new URL("0096_social_transactions_open_claims.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await rows(admin, "SELECT 1 FROM pg_indexes WHERE indexname = 'social_transactions_open_claims_idx'"), []);
    await admin.query(await readFile(new URL("0096_social_transactions_open_claims.up.sql", MIGRATIONS), "utf8"));
    assert.equal((await rows(admin, "SELECT 1 FROM pg_indexes WHERE indexname = 'social_transactions_open_claims_idx'")).length, 1);
  } finally {
    await admin.end();
    await drop();
  }
});

test("0097 (OA-25 Q16): one snapshot per account and UTC day, a valued day final, when a portfolio became public, the worker's statements on their indexes; down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const owner = await insertNewAccount(admin, 97, "snapshot_owner");
    const day = Date.UTC(2026, 9, 6);
    const insert = (values: Readonly<Record<string, unknown>>) => {
      const row = { account_id: owner, day: "2026-10-06", taken_at_ms: day + 300_000, checkpoint: 1, ...values };
      const columns = Object.keys(row);
      return admin.query(
        `INSERT INTO social_portfolio_snapshots (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    const parts = { committed_usd: "1.00", claimable_usd: "2.00", tokens_usd: "3.00", usdc_usd: "4.00", sui_usd: "5.00" };
    await insert({ value_usd: "15.00", ...parts, prices_as_of_ms: day });
    // One row per account and day.
    await assert.rejects(insert({ skipped: "price_missing" }), { code: "23505", constraint: "social_portfolio_snapshots_pkey" });
    // The value is the parts' sum; a skipped day holds no figure; the reasons are the two the worker writes; the day is taken_at's UTC day.
    await assert.rejects(insert({ day: "2026-10-05", taken_at_ms: day - 1, value_usd: "15.01", ...parts }), { code: "23514", constraint: "social_portfolio_snapshots_valued" });
    await assert.rejects(insert({ day: "2026-10-05", taken_at_ms: day - 1, skipped: "price_missing", tokens_usd: "3.00" }), { code: "23514", constraint: "social_portfolio_snapshots_valued" });
    await assert.rejects(insert({ day: "2026-10-05", taken_at_ms: day - 1, skipped: "price_missing", prices_as_of_ms: day }), { code: "23514", constraint: "social_portfolio_snapshots_valued" });
    await assert.rejects(insert({ day: "2026-10-05", taken_at_ms: day - 1, skipped: "estimated" }), { code: "23514" });
    await assert.rejects(insert({ day: "2026-10-05", taken_at_ms: day, skipped: "price_missing" }), { code: "23514", constraint: "social_portfolio_snapshots_day" });
    await insert({ day: "2026-10-05", taken_at_ms: day - 1, skipped: "balances_unavailable" });
    // A skipped day may be replaced by a later attempt; a valued one never changes, nor moves to another account or day.
    await admin.query(
      `UPDATE social_portfolio_snapshots SET skipped = NULL, value_usd = 15.00, committed_usd = 1, claimable_usd = 2, tokens_usd = 3, usdc_usd = 4, sui_usd = 5
       WHERE account_id = $1 AND day = '2026-10-05'`,
      [owner],
    );
    for (const change of ["checkpoint = 2", "value_usd = 15.00", "skipped = 'price_missing', value_usd = NULL, committed_usd = NULL, claimable_usd = NULL, tokens_usd = NULL, usdc_usd = NULL, sui_usd = NULL, prices_as_of_ms = NULL"]) {
      await assert.rejects(admin.query(`UPDATE social_portfolio_snapshots SET ${change} WHERE account_id = $1 AND day = '2026-10-05'`, [owner]), {
        code: "23514",
        constraint: "social_portfolio_snapshots_valued_final",
      });
    }
    // When the portfolio became public (the owner's answer of 2026-10-06): set when it becomes visible to others, kept while it
    // stays visible, cleared when the switch goes off or the account goes private, for every writer.
    const since = async () => (await rows<{ since: Date | null }>(admin, "SELECT portfolio_public_since AS since FROM social_accounts WHERE account_id = $1", [owner]))[0]!.since;
    const set = (assignments: string) => admin.query(`UPDATE social_accounts SET ${assignments} WHERE account_id = $1`, [owner]);
    assert.equal(await since(), null);
    await set("portfolio_public = true");
    const first = await since();
    assert.ok(first && Math.abs(first.getTime() - Date.now()) < 60_000);
    await set("display_name = 'Still public'");
    await set("portfolio_public = true, privacy = 'public'");
    assert.deepEqual(await since(), first);
    // While visible it may be moved (an operator correction, or a test's backdated history), never cleared.
    await set("portfolio_public_since = '2026-09-01T01:00:00Z'");
    assert.deepEqual(await since(), new Date("2026-09-01T01:00:00Z"));
    await assert.rejects(set("portfolio_public_since = NULL"), { code: "23514", constraint: "social_accounts_portfolio_public_since" });
    await set("privacy = 'private', sharing_since = NULL");
    assert.equal(await since(), null);
    await set("privacy = 'public', sharing_since = now()");
    const again = await since();
    assert.ok(again && again.getTime() > new Date("2026-09-02T00:00:00Z").getTime());
    await set("portfolio_public = false");
    assert.equal(await since(), null);
    // Not visible: nothing can give it a start.
    await set("portfolio_public_since = now()");
    assert.equal(await since(), null);
    const visibleAtBirth = uuid(0x97b1);
    await admin.query("INSERT INTO social_accounts (account_id, privy_did, callsign, portfolio_public) VALUES ($1, 'did:privy:born-public', 'born_public', true)", [visibleAtBirth]);
    assert.equal((await rows<{ set: boolean }>(admin, "SELECT portfolio_public_since IS NOT NULL AS set FROM social_accounts WHERE account_id = $1", [visibleAtBirth]))[0]!.set, true);

    // The worker's statements and the trend read take their indexes (sequential scans off, so a small table still shows the path).
    await insert({ day: "2026-10-04", taken_at_ms: day - 86_400_001, skipped: "price_missing" });
    await admin.query("BEGIN");
    await admin.query("SET LOCAL enable_seqscan = off");
    const plan = async (sql: string, values: unknown[]) =>
      (await rows<{ "QUERY PLAN": string }>(admin, `EXPLAIN ${sql}`, values)).map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(await plan(PORTFOLIO_TREND_STATEMENTS.snapshots, [owner, "2026-10-07", "-infinity", 32]), /Index Only Scan Backward using social_portfolio_snapshots_pkey/);
    await admin.query("ROLLBACK");
    const definitions = await rows<{ indexdef: string }>(admin, "SELECT indexdef FROM pg_indexes WHERE tablename = 'social_portfolio_snapshots' ORDER BY indexname");
    assert.deepEqual(definitions.map((row) => row.indexdef.replace(/^.*USING /, "")), [
      "btree (account_id, day) INCLUDE (value_usd)",
      "btree (day, account_id) WHERE (skipped IS NOT NULL)",
    ]);
    // 0108's balance observations reference snapshots: reverse that dependency before 0097.
    await admin.query(await readFile(new URL("0108_social_shared_evidence.down.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0097_social_portfolio_snapshots.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await rows(admin, `SELECT 1 FROM pg_class WHERE relname = 'social_portfolio_snapshots'
      UNION ALL SELECT 1 FROM pg_proc WHERE proname IN ('social_portfolio_snapshots_check_update', 'social_accounts_set_portfolio_public_since')
      UNION ALL SELECT 1 FROM information_schema.columns WHERE table_name = 'social_accounts' AND column_name = 'portfolio_public_since'`), []);
    await admin.query(await readFile(new URL("0097_social_portfolio_snapshots.up.sql", MIGRATIONS), "utf8"));
    await admin.query(await readFile(new URL("0108_social_shared_evidence.up.sql", MIGRATIONS), "utf8"));
    await insert({ value_usd: "15.00", ...parts });
    // Up again: a portfolio already public starts its public history at the migration, never earlier.
    assert.equal((await rows<{ set: boolean }>(admin, "SELECT portfolio_public_since IS NOT NULL AS set FROM social_accounts WHERE account_id = $1", [visibleAtBirth]))[0]!.set, true);
    assert.equal(await since(), null);
    const grants = await rows<{ grantee: string; privileges: string }>(
      admin,
      `SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
       FROM information_schema.role_table_grants WHERE table_name = 'social_portfolio_snapshots' AND grantee <> current_user
       GROUP BY grantee ORDER BY grantee`,
    );
    assert.deepEqual(grants, [
      { grantee: "blast_replica", privileges: "SELECT" },
      { grantee: "blast_watcher", privileges: "DELETE,INSERT,SELECT,UPDATE" },
      { grantee: "blast_web", privileges: "SELECT" },
    ]);
  } finally {
    await admin.end();
    await drop();
  }
});

test("0098: a why on a trade's entry (event_slot u32::MAX) gets the trade's sale; no entry id makes the trigger fail; down restores 0066's function", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const author = await insertNewAccount(admin, 98, "trade_author");
    // T-038's trades are found by balance changes, not events: blast-infra writes them at event_slot u32::MAX.
    const trade = (part: number) => ({
      ...CHAIN_READ_ROWS.activity.find((row) => row.kind === "trade_buy")!,
      checkpoint: 1_210, tx_slot: 2, event_slot: 4_294_967_295, part, digest: `Trd0098${part}`.padEnd(44, "1"),
    });
    await seedChainRead(admin, { activity: [trade(0), trade(1)] });
    const presaleOf = async (entry: string) =>
      (await rows<{ presale_id: string | null }>(admin, "SELECT social_whys_presale_of($1) AS presale_id", [entry]))[0]!.presale_id;
    /** A why inserted as the web runtime (the why route's role), rolled back; its stored sale, or the SQLSTATE that refused it. */
    const whyAsWeb = async (entry: string): Promise<string | null> => {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE blast_web");
        const inserted = await client.query<{ presale_id: string | null }>(
          "INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, 'on a trade') RETURNING presale_id",
          [uuid(0x9800), entry, author],
        );
        return inserted.rows[0]!.presale_id;
      } catch (error) {
        return `error ${(error as { code?: string }).code}`;
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    };
    const tradeEntry = "a:1210:2:4294967295:0";
    assert.equal(await whyAsWeb(tradeEntry), FIXTURE_PRESALE_ID);
    assert.equal(await presaleOf("a:1210:2:4294967295:1"), FIXTURE_PRESALE_ID);
    // A commit's entry finds its sale as before; anything that is not an activity row's id keeps a null sale and never fails.
    assert.equal(await presaleOf("a:1000:0:0:0"), FIXTURE_PRESALE_ID);
    for (const entry of [
      lifecycleEntryId(FIXTURE_PRESALE_ID, "funded"),
      milestoneEntryId(FIXTURE_PRESALE_ID, "participants", "100"),
      "a:1210:2:42949672950:0",
      `a:${"9".repeat(19)}:0:0:0`,
      "a:1210:2:4294967295",
      "a:-1:0:0:0",
    ]) {
      assert.equal(await presaleOf(entry), null, entry);
      assert.equal(await whyAsWeb(entry), null, entry);
    }
    // The plan is still the activity key's: one probe, never a scan of the log.
    await admin.query("BEGIN");
    await admin.query("SET LOCAL enable_seqscan = off");
    const plan = (await rows<{ "QUERY PLAN": string }>(
      admin,
      `EXPLAIN SELECT a.presale_id FROM chain_read_v1.activity a
       WHERE a.checkpoint = CASE WHEN $1::text ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN split_part($1::text, ':', 2)::bigint END
         AND a.tx_slot = CASE WHEN $1::text ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN split_part($1::text, ':', 3)::bigint END
         AND a.event_slot = CASE WHEN $1::text ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN split_part($1::text, ':', 4)::bigint END
         AND a.part = CASE WHEN $1::text ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN split_part($1::text, ':', 5)::bigint END`,
      [tradeEntry],
    )).map((row) => row["QUERY PLAN"]).join("\n");
    await admin.query("ROLLBACK");
    assert.match(plan, /Index Scan using activity_pkey/);
    // Down: 0066's `::integer` refuses the trade's why again (22003, the defect), and a commit's still works; up fixes it.
    await admin.query(await readFile(new URL("0098_social_whys_presale_bigint.down.sql", MIGRATIONS), "utf8"));
    assert.equal(await whyAsWeb(tradeEntry), "error 22003");
    assert.equal(await presaleOf("a:1000:0:0:0"), FIXTURE_PRESALE_ID);
    await admin.query(await readFile(new URL("0098_social_whys_presale_bigint.up.sql", MIGRATIONS), "utf8"));
    assert.equal(await whyAsWeb(tradeEntry), FIXTURE_PRESALE_ID);
  } finally {
    await admin.end();
    await drop();
  }
});

test("R3-23 (0088): a sale's trust flags name who set each and when, only the owner writes them, and the migration goes down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  /** Runs `sql` as `role` in its own transaction, rolled back. */
  const as = async (role: "blast_web" | "blast_replica" | "blast_watcher", sql: string) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query(`SET LOCAL ROLE ${role}`);
      return await own.query(sql);
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const sale = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    const insert = (n: number, columns: Record<string, unknown>) => {
      const row: Record<string, unknown> = { presale_id: sale(n), updated_at_ms: 1_791_000_000_000, ...columns };
      const names = Object.keys(row);
      return admin.query(
        `INSERT INTO social_sale_trust (${names.join(", ")}) VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
        Object.values(row),
      );
    };
    // A row with no flag set names nobody; a set flag names its operator and time.
    assert.equal((await insert(1, {})).rowCount, 1);
    assert.equal((await insert(2, { verified_team: true, verified_by: "ops.a", verified_at_ms: 1, note: "checked" })).rowCount, 1);
    assert.equal((await insert(3, { audited: true, audited_by: "ops.a", audited_at_ms: 1 })).rowCount, 1);
    assert.deepEqual(
      await rows(admin, "SELECT verified_team, audited FROM social_sale_trust WHERE presale_id = $1", [sale(1)]),
      [{ verified_team: false, audited: false }],
      "every flag defaults to false",
    );
    // OA-26: the LP lock is protocol-wide, so the table has no column for it.
    assert.deepEqual(
      (await rows<{ c: string }>(admin, "SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'social_sale_trust' AND column_name LIKE 'lp%'")),
      [],
    );
    for (const [n, bad] of [
      [10, { verified_team: true }],
      [11, { verified_team: true, verified_by: "ops.a" }],
      [12, { verified_by: "ops.a", verified_at_ms: 1 }],
      [13, { audited: true, audited_at_ms: 1 }],
      [14, { audited_by: "ops.a" }],
      [15, { note: "" }],
      [16, { note: "x".repeat(501) }],
      [17, { updated_at_ms: 0 }],
      [18, { presale_id: "0xABC" }],
      [19, { presale_id: `0x${"A".repeat(64)}` }],
      [20, { verified_team: true, verified_by: "", verified_at_ms: 1 }],
    ] as const) {
      await assert.rejects(insert(n, bad), { code: "23514" }, JSON.stringify(bad));
    }
    await assert.rejects(insert(2, {}), { code: "23505", constraint: "social_sale_trust_pkey" });

    // Read by the web runtime and the replica; the watcher never reads it. No runtime role writes the
    // audited flag or deletes a row (0165 lets the web role write the verified columns only; below).
    assert.equal((await as("blast_web", "SELECT count(*) FROM social_sale_trust")).rows.length, 1);
    assert.equal((await as("blast_replica", "SELECT count(*) FROM social_sale_trust")).rows.length, 1);
    await assert.rejects(as("blast_watcher", "SELECT count(*) FROM social_sale_trust"), { code: "42501" });
    for (const role of ["blast_web", "blast_replica", "blast_watcher"] as const) {
      for (const sql of [
        `INSERT INTO social_sale_trust (presale_id, audited, updated_at_ms) VALUES ('${sale(30)}', FALSE, 1)`,
        `UPDATE social_sale_trust SET audited = FALSE, audited_by = NULL, audited_at_ms = NULL WHERE presale_id = '${sale(3)}'`,
        `DELETE FROM social_sale_trust WHERE presale_id = '${sale(2)}'`,
        "TRUNCATE social_sale_trust",
      ]) {
        await assert.rejects(as(role, sql), { code: "42501" }, `${role}: ${sql}`);
      }
    }
    const grants = await rows<{ grantee: string; privileges: string }>(
      admin,
      `SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
       FROM information_schema.role_table_grants WHERE table_name = 'social_sale_trust' AND grantee <> current_user
       GROUP BY grantee ORDER BY grantee`,
    );
    assert.deepEqual(grants, [{ grantee: "blast_replica", privileges: "SELECT" }, { grantee: "blast_web", privileges: "SELECT" }]);

    // The history read's index: one sale's set and clear rows in the operator log, newest first.
    const [index] = await rows<{ indexdef: string }>(admin, "SELECT indexdef FROM pg_indexes WHERE indexname = 'social_operator_log_sale_trust_idx'");
    assert.match(index!.indexdef, /ON public\.social_operator_log USING btree \(target, acted_at DESC, log_id DESC\) WHERE \(action = ANY \(ARRAY\['sale\.trust\.set'::text, 'sale\.trust\.clear'::text\]\)\)$/);

    // 0088 goes down and up again on its own, leaving the operator log and its rows in place.
    await admin.query("INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('ops.a', 'sale.trust.set', $1, 'kept')", [sale(2)]);
    await admin.query("BEGIN");
    await admin.query(await readFile(new URL("0088_social_sale_trust.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(
      await rows(admin, "SELECT to_regclass('social_sale_trust') AS t, to_regclass('social_operator_log_sale_trust_idx') AS i, (SELECT count(*)::int FROM social_operator_log) AS log"),
      [{ t: null, i: null, log: 1 }],
    );
    await admin.query(await readFile(new URL("0088_social_sale_trust.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await rows(admin, "SELECT count(*)::int AS n FROM social_sale_trust"), [{ n: 0 }]);
    await admin.query("ROLLBACK");
  } finally {
    await admin.end();
    await drop();
  }
});

test("0165: the admin website's verified mark gets narrow web grants, and the migration goes down and up without changing a mark or a log row", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const asWeb = async (sql: string) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query("SET LOCAL ROLE blast_web");
      return await own.query(sql);
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const sale = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    const coin = `0x${"ab".repeat(32)}::meme::MEME`;
    await admin.query(
      `INSERT INTO social_sale_trust (presale_id, verified_team, verified_by, verified_at_ms, audited, audited_by, audited_at_ms, note, updated_at_ms)
       VALUES ($1, TRUE, 'ops.a', 1, FALSE, NULL, NULL, 'KARES', 1), ($2, TRUE, 'ops.a', 2, TRUE, 'ops.b', 3, 'Nogas', 3), ($3, FALSE, NULL, NULL, TRUE, 'ops.b', 4, 'audit only', 4)`,
      [sale(1), sale(2), sale(3)],
    );
    await admin.query("INSERT INTO social_coin_trust (coin_type, verified_by, verified_at_ms, note) VALUES ($1, 'ops.a', 5, 'BlastOff')", [coin]);
    await admin.query("INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('ops.a', 'sale.trust.set', $1, 'kept')", [sale(1)]);
    // The check the deploy runs on production before and after: every trust row and log row, byte for byte.
    const fingerprint = async () => rows(admin, `SELECT
        (SELECT count(*)::int FROM social_sale_trust) AS sales, (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.presale_id), '')) FROM social_sale_trust t) AS sale_md5,
        (SELECT count(*)::int FROM social_coin_trust) AS coins, (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.coin_type), '')) FROM social_coin_trust t) AS coin_md5,
        (SELECT count(*)::int FROM social_operator_log) AS logs, (SELECT md5(coalesce(string_agg(l::text, '|' ORDER BY l.log_id), '')) FROM social_operator_log l) AS log_md5`);
    const before = await fingerprint();

    // Applied: the web role appends log rows, inserts and deletes coin marks, and writes only a sale's verified columns.
    for (const sql of [
      "INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('admin-console', 'coin.trust.set', 'x', 'probe')",
      `INSERT INTO social_coin_trust (coin_type, verified_by, verified_at_ms, note) VALUES ('0x${"cd".repeat(32)}::meme::MEME', 'admin-console', 1, 'probe')`,
      `DELETE FROM social_coin_trust WHERE coin_type = '${coin}'`,
      `INSERT INTO social_sale_trust (presale_id, verified_team, verified_by, verified_at_ms, note, updated_at_ms) VALUES ('${sale(9)}', TRUE, 'admin-console', 1, 'probe', 1)`,
      `UPDATE social_sale_trust SET verified_team = FALSE, verified_by = NULL, verified_at_ms = NULL, note = 'probe', updated_at_ms = 9 WHERE presale_id = '${sale(2)}'`,
    ]) {
      await asWeb(sql);
    }
    for (const sql of [
      // The web role appends only the admin website's own mark rows, never another operator's.
      "INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('ops.a', 'coin.trust.set', 'x', 'forged')",
      "INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('admin-console', 'config.set', 'x', 'forged')",
      "INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('admin-console', 'coin.trust.set', 'x', ' ')",
      "UPDATE social_operator_log SET reason = 'rewritten'",
      "DELETE FROM social_operator_log",
      "UPDATE social_coin_trust SET note = 'rewritten'",
      `UPDATE social_sale_trust SET audited = FALSE, audited_by = NULL, audited_at_ms = NULL WHERE presale_id = '${sale(2)}'`,
      `INSERT INTO social_sale_trust (presale_id, audited, audited_by, audited_at_ms, updated_at_ms) VALUES ('${sale(9)}', TRUE, 'web', 1, 1)`,
      `DELETE FROM social_sale_trust WHERE presale_id = '${sale(1)}'`,
    ]) {
      await assert.rejects(asWeb(sql), { code: "42501" }, sql);
    }
    // The CLI runs as the table's owner, which need not be a superuser: it still appends any row, NULL reason included.
    {
      const own = await admin.connect();
      try {
        await own.query("BEGIN");
        await own.query("CREATE ROLE verified_mark_owner_probe NOLOGIN");
        await own.query("ALTER TABLE social_operator_log OWNER TO verified_mark_owner_probe");
        await own.query("SET LOCAL ROLE verified_mark_owner_probe");
        assert.equal((await own.query("INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('ops.a', 'config.get', 'x', NULL)")).rowCount, 1);
        // A temp table named pg_class cannot make the web role look like the owner.
        await own.query("RESET ROLE");
        await own.query("SET LOCAL ROLE blast_web");
        await own.query("CREATE TEMP TABLE pg_class (oid oid, relowner oid)");
        await own.query("INSERT INTO pg_temp.pg_class SELECT 'social_operator_log'::regclass, oid FROM pg_catalog.pg_roles WHERE rolname = 'blast_web'");
        await assert.rejects(own.query("INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('ops.a', 'config.set', 'x', 'forged')"), { code: "42501" });
      } finally {
        await own.query("ROLLBACK").catch(() => undefined);
        own.release();
      }
    }

    // Down: the web role is read-only again; up: the same grants. Neither touches a row.
    await admin.query(await readFile(new URL("0165_admin_verified_mark.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await fingerprint(), before);
    for (const sql of [
      "INSERT INTO social_operator_log (operator_id, action, target, reason) VALUES ('admin-console', 'coin.trust.set', 'x', 'probe')",
      `DELETE FROM social_coin_trust WHERE coin_type = '${coin}'`,
      `UPDATE social_sale_trust SET note = 'probe' WHERE presale_id = '${sale(2)}'`,
    ]) {
      await assert.rejects(asWeb(sql), { code: "42501" }, sql);
    }
    await admin.query(await readFile(new URL("0165_admin_verified_mark.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await fingerprint(), before);
    assert.equal((await asWeb(`DELETE FROM social_coin_trust WHERE coin_type = '${coin}'`)).rowCount, 1);
    assert.deepEqual(await fingerprint(), before, "the probe rolled back");
  } finally {
    await admin.end();
    await drop();
  }
});

test("R3-31 (0089): a trade is one row per key and digest, built with its bytes or refused with a code, settled once from the chain, never edited or deleted; the sponsor takes a trade intent", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const asWeb = async (sql: string, values: unknown[] = []) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query("SET LOCAL ROLE blast_web");
      return await own.query(sql, values);
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const kai = await insertNewAccount(admin, 89, "trade_kai");
    const digest = (n: number) => `${"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkL".slice(0, 40)}${String(n).padStart(3, "1")}`;
    const key = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    const now = Date.now();
    const later = now + 60_000;
    const sale = `${wallet(0xb0b)}::coin::BEE`;
    const insert = (n: number, overrides: Record<string, unknown> = {}) => {
      const row = {
        state: "built", fee_payer: "blast", reservation_id: uuid(0x8900 + n) as string | null, tx_bytes: Buffer.from([n]) as Buffer | null, digest: digest(n) as string | null,
        expires_at_ms: (now + 110_000) as number | null, failure_code: null as string | null, amount_out_filled: null as string | null,
        settled_at_ms: null as number | null, min_out: "995", amount_out: "1000", key: key(n), route: JSON.stringify([{ pool_id: wallet(0x900), venue: "cetus" }]),
        in_coin: "0x2::sui::SUI", ...overrides,
      };
      return admin.query(
        `INSERT INTO social_swap_intents (trade_id, account_id, idempotency_key, quote_digest, side, sender, in_coin, out_coin, amount_in, amount_out,
           min_out, slippage_bps, route, quote_expires_at_ms, fee_payer, reservation_id, tx_bytes, digest, expires_at_ms, state, failure_code,
           amount_out_filled, created_at_ms, settled_at_ms)
         VALUES ($1, $2, $3, $4, 'buy', $5, $6, $7, 100, $8::numeric, $9::numeric, 50, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19::numeric,
           $20, $21)`,
        [uuid(0x8900 + n), kai, row.key, Buffer.alloc(32, n), wallet(0x89), row.in_coin, sale, row.amount_out, row.min_out, row.route, now + 20_000,
          row.fee_payer, row.reservation_id, row.tx_bytes, row.digest, row.expires_at_ms, row.state, row.failure_code, row.amount_out_filled, now, row.settled_at_ms],
      );
    };
    const refused = { state: "failed", fee_payer: null, reservation_id: null, tx_bytes: null, digest: null, expires_at_ms: null, settled_at_ms: now };
    assert.equal((await insert(1)).rowCount, 1, "built, sponsored");
    assert.equal((await insert(2, { fee_payer: "wallet", reservation_id: null })).rowCount, 1, "built, the wallet pays");
    assert.equal((await insert(3, { ...refused, failure_code: "price_moved" })).rowCount, 1, "refused before anything was built");
    assert.equal((await insert(4, { state: "confirmed", amount_out_filled: "996", settled_at_ms: later })).rowCount, 1, "confirmed from the chain");
    for (const [n, bad] of [
      [5, { state: "built", tx_bytes: null }],
      [6, { ...refused }],
      [7, { state: "confirmed", settled_at_ms: later }],
      [8, { state: "confirmed", amount_out_filled: "994", settled_at_ms: later }],
      [9, { fee_payer: "wallet" }],
      [10, { min_out: "1001" }],
      [11, { key: "not-a-uuid" }],
      [12, { route: "[]" }],
      [13, { ...refused, failure_code: "MoveAbort(0x2::coin, 7)" }],
      [14, { digest: "not-a-digest" }],
      [15, { in_coin: sale }],
      [16, { settled_at_ms: later }],
    ] as const) {
      await assert.rejects(insert(n, bad), { code: "23514" }, JSON.stringify(bad));
    }
    await assert.rejects(insert(17, { key: key(1) }), { code: "23505", constraint: "social_swap_intents_key" });
    await assert.rejects(insert(18, { digest: digest(1) }), { code: "23505", constraint: "social_swap_intents_digest_idx" });
    const indexes = await rows<{ indexname: string; indexdef: string }>(admin, "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'social_swap_intents' ORDER BY 1");
    assert.deepEqual(indexes.map((row) => row.indexname), [
      "social_swap_intents_digest_idx", "social_swap_intents_key", "social_swap_intents_pkey", "social_swap_intents_sponsored_idx", "social_swap_intents_tracking_idx",
    ]);
    // The legacy sponsorship index excludes expired trades.
    assert.match(indexes[3]!.indexdef, /\(account_id, created_at_ms\) WHERE \(\(fee_payer = 'blast'::text\) AND \(failure_code IS DISTINCT FROM 'expired'::text\)\)$/);

    // The web runtime settles a built trade (rolled back here) and has no DELETE.
    assert.equal(
      (await asWeb("UPDATE social_swap_intents SET state = 'confirmed', amount_out_filled = 999, settled_at_ms = $2 WHERE trade_id = $1", [uuid(0x8901), later])).rowCount,
      1,
    );
    await assert.rejects(asWeb("DELETE FROM social_swap_intents WHERE trade_id = $1", [uuid(0x8901)]), { code: "42501" });
    for (const [sql, values, constraint] of [
      ["UPDATE social_swap_intents SET min_out = 1 WHERE trade_id = $1", [uuid(0x8901)], "social_swap_intents_never_edited"],
      ["UPDATE social_swap_intents SET digest = $2 WHERE trade_id = $1", [uuid(0x8901), digest(40)], "social_swap_intents_never_edited"],
      ["UPDATE social_swap_intents SET route = '[{}]'::jsonb WHERE trade_id = $1", [uuid(0x8901)], "social_swap_intents_never_edited"],
      ["UPDATE social_swap_intents SET fee_payer = 'wallet', reservation_id = NULL WHERE trade_id = $1", [uuid(0x8901)], "social_swap_intents_never_edited"],
      ["UPDATE social_swap_intents SET state = 'built', settled_at_ms = NULL, failure_code = NULL WHERE trade_id = $1", [uuid(0x8903)], "social_swap_intents_settled_final"],
      ["UPDATE social_swap_intents SET amount_out_filled = 997 WHERE trade_id = $1", [uuid(0x8904)], "social_swap_intents_settled_final"],
    ] as const) {
      await assert.rejects(admin.query(sql, [...values]), { code: "23514", constraint }, sql);
      await assert.rejects(asWeb(sql, [...values]), { code: "23514", constraint }, `${sql} as blast_web`);
    }

    // The sponsor's trade intent names no presale; 0089's down refuses while a trade or a trade reservation exists.
    const own = await admin.connect();
    try {
      const reserve = (intent: string, presaleId: string | null) =>
        own.query(
          `INSERT INTO presale_sponsor_reservations (privy_did, sender, presale_id, intent, gas_budget, expires_at, pool_deadline)
           VALUES ('did:privy:trade-89', $1, $2, $3, 2000000, now() + interval '2 minutes', now() + interval '5 seconds')`,
          [wallet(0x89), presaleId, intent],
        );
      /** Runs `run` in a savepoint that is always rolled back, so a refusal leaves the transaction usable. */
      const attempt = async (run: () => Promise<unknown>) => {
        await own.query("SAVEPOINT attempt");
        try {
          return await run();
        } finally {
          await own.query("ROLLBACK TO SAVEPOINT attempt");
        }
      };
      await own.query("BEGIN");
      await reserve("trade", null);
      await assert.rejects(attempt(() => reserve("trade", wallet(0x51))), { code: "23514", constraint: "presale_sponsor_reservations_presale_by_intent" });
      const down = await readFile(new URL("0089_social_swap_intents.down.sql", MIGRATIONS), "utf8");
      await assert.rejects(attempt(() => own.query(down)), /trades exist/);
      await own.query("DROP TABLE social_swap_receipts");
      await own.query("DELETE FROM social_swap_intents");
      await assert.rejects(attempt(() => own.query(down)), /sponsored trade reservations exist/);
      await own.query("DELETE FROM presale_sponsor_reservations WHERE intent = 'trade'");
      await own.query(down);
      assert.deepEqual(
        (await own.query("SELECT to_regclass('social_swap_intents') AS t, to_regproc('social_swap_intents_check_update') AS f")).rows,
        [{ t: null, f: null }],
      );
      await assert.rejects(attempt(() => reserve("trade", null)), { code: "23514", constraint: "presale_sponsor_reservations_intent_check" });
      await reserve("withdraw", null);
      await own.query(await readFile(new URL("0089_social_swap_intents.up.sql", MIGRATIONS), "utf8"));
      await reserve("trade", null);
      await own.query("ROLLBACK");
    } finally {
      own.release();
    }
  } finally {
    await admin.end();
    await drop();
  }
});

/** `social_accounts.sound`'s type, nullability and default, or nothing when the column is gone. */
function soundColumn(admin: Pool) {
  return rows<{ data_type: string; is_nullable: string; column_default: string | null }>(
    admin,
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'social_accounts' AND column_name = 'sound'`,
  );
}

test("R3-12 (0093): the account's sound column is a boolean the web writes, defaulting on until 0099; the migration goes down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    // 0093 as it stood before 0099: 0099 goes down first.
    await admin.query(await readFile(new URL("0099_social_account_sound_unset.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await soundColumn(admin), [{ data_type: "boolean", is_nullable: "NO", column_default: "true" }]);
    const kai = await insertNewAccount(admin, 93, "sound_kai");
    assert.deepEqual(await rows(admin, "SELECT sound FROM social_accounts WHERE account_id = $1", [kai]), [{ sound: true }]);
    await assert.rejects(admin.query("UPDATE social_accounts SET sound = NULL WHERE account_id = $1", [kai]), { code: "23502" });

    // The web writes it (0054's table grant); nothing new was granted to anyone.
    const web = await admin.connect();
    try {
      await web.query("BEGIN");
      await web.query("SET LOCAL ROLE blast_web");
      assert.equal((await web.query("UPDATE social_accounts SET sound = false WHERE account_id = $1", [kai])).rowCount, 1);
      await web.query("COMMIT");
    } finally {
      await web.query("ROLLBACK").catch(() => undefined);
      web.release();
    }
    assert.deepEqual(await rows(admin, "SELECT sound FROM social_accounts WHERE account_id = $1", [kai]), [{ sound: false }]);

    // Down drops the column and nothing else; up brings it back at its default; 0099 then applies again.
    await admin.query(await readFile(new URL("0093_social_account_sound.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await soundColumn(admin), []);
    await admin.query(await readFile(new URL("0093_social_account_sound.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await soundColumn(admin), [{ data_type: "boolean", is_nullable: "NO", column_default: "true" }]);
    assert.deepEqual(await rows(admin, "SELECT sound FROM social_accounts WHERE account_id = $1", [kai]), [{ sound: true }]);
    await admin.query(await readFile(new URL("0099_social_account_sound_unset.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await soundColumn(admin), [{ data_type: "boolean", is_nullable: "YES", column_default: null }]);
  } finally {
    await admin.end();
    await drop();
  }
});

test("OA-33 (0099): an account that never chose has no sound choice (NULL), not on; 0093's defaults become NULL, explicit offs are kept; down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const soundOf = async (accountId: string) =>
    (await rows<{ sound: boolean | null }>(admin, "SELECT sound FROM social_accounts WHERE account_id = $1", [accountId]))[0]!.sound;
  try {
    // After every migration: nullable, no default — a new account has not chosen.
    assert.deepEqual(await soundColumn(admin), [{ data_type: "boolean", is_nullable: "YES", column_default: null }]);
    const ana = await insertNewAccount(admin, 990, "sound_ana");
    assert.equal(await soundOf(ana), null);
    // The web writes a choice, either way (0054's table grant; no grant changed).
    const web = await admin.connect();
    try {
      await web.query("BEGIN");
      await web.query("SET LOCAL ROLE blast_web");
      assert.equal((await web.query("UPDATE social_accounts SET sound = true WHERE account_id = $1", [ana])).rowCount, 1);
      await web.query("COMMIT");
    } finally {
      await web.query("ROLLBACK").catch(() => undefined);
      web.release();
    }
    assert.equal(await soundOf(ana), true);

    // Down: 0093's column again; "not chosen" reads on, as 0093 defined it; an explicit choice is kept.
    const bo = await insertNewAccount(admin, 991, "sound_bo");
    const cy = await insertNewAccount(admin, 992, "sound_cy");
    await admin.query("UPDATE social_accounts SET sound = false WHERE account_id = $1", [cy]);
    await admin.query(await readFile(new URL("0099_social_account_sound_unset.down.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await soundColumn(admin), [{ data_type: "boolean", is_nullable: "NO", column_default: "true" }]);
    assert.deepEqual([await soundOf(ana), await soundOf(bo), await soundOf(cy)], [true, true, false]);

    // Up over 0093's rows: every true (0093's default; 0093 was never deployed, so no person chose it) becomes
    // NULL, and a false — which only a person's PUT could write — is kept.
    const dee = await insertNewAccount(admin, 993, "sound_dee");
    assert.equal(await soundOf(dee), true, "0093's default");
    await admin.query(await readFile(new URL("0099_social_account_sound_unset.up.sql", MIGRATIONS), "utf8"));
    assert.deepEqual(await soundColumn(admin), [{ data_type: "boolean", is_nullable: "YES", column_default: null }]);
    assert.deepEqual([await soundOf(ana), await soundOf(bo), await soundOf(cy), await soundOf(dee)], [null, null, false, null]);
    const eve = await insertNewAccount(admin, 994, "sound_eve");
    assert.equal(await soundOf(eve), null);
  } finally {
    await admin.end();
    await drop();
  }
});

test("T-001-AC-7: the reversible social migrations go down and up again; every social relation is owned", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  try {
    const relations = () => rows<{ name: string }>(
      admin,
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm') AND (
         (n.nspname = 'public' AND (c.relname LIKE 'social\\_%' OR c.relname = 'presale_reward_blacklists')) OR n.nspname = 'chain_read_v1'
       ) ORDER BY 1`,
    );
    const names = (await relations()).map((row) => row.name);
    assert.deepEqual(
      names.filter((name) => name.startsWith("public.")).map((name) => name.slice("public.".length)).sort(),
      [...TABLE_OWNERSHIP.social].sort(),
      "every social relation is owned by module social",
    );
    assert.deepEqual(names.filter((name) => name.startsWith("chain_read_v1.")).sort(), [...CHAIN_FIXTURE_VIEWS].sort());
    const approvedViews = new Set<string>(CHAIN_READ_VIEWS);
    for (const view of CHAIN_FIXTURE_VIEWS) assert.ok(approvedViews.has(view), `${view} must be an approved chain read`);

    const socialMigrations = async () => (await rows<{ name: string }>(
      admin,
      "SELECT name FROM mission_control_schema_migrations WHERE name >= '0054' ORDER BY name",
    )).map((row) => row.name);
    const currentMigrations = await socialMigrations();

    // Rehearse the reversible prefix on a fresh database. Starting with 0151,
    // the reward migrations require a snapshot to roll back.
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    await migrateDatabase(admin, { through: "0150_reward_treasury_retention" });

    // 0058: wallet sign-in challenges are allowed (and their rows go with the migration's down).
    const signInChallenge = (n: number) =>
      admin.query(
        `INSERT INTO mission_control_wallet_challenges (
           challenge_id, action, wallet_address, origin, context_kind, context_id, nonce_hash, message_hash, issued_at, expires_at
         ) VALUES ($1, 'sign_in', $2, 'https://blast.fun', 'attempt', 'sign-in-1', $3, $3, now(), now() + interval '5 minutes')`,
        [uuid(0x5800 + n), wallet(0x5800 + n), n.toString(16).padStart(64, "0")],
      );
    await signInChallenge(1);
    await assert.rejects(
      admin.query(
        `INSERT INTO mission_control_wallet_challenges (
           challenge_id, action, wallet_address, origin, context_kind, context_id, nonce_hash, message_hash, issued_at, expires_at
         ) VALUES ($1, 'sign_in', $2, 'https://blast.fun', 'account', 'a', $3, $3, now(), now() + interval '5 minutes')`,
        [uuid(0x5900), wallet(0x5900), "f".repeat(64)],
      ),
      { code: "23514", constraint: "mission_control_wallet_challenges_action_context_check" },
    );

    // 0058's down refuses while a wallet-only account exists, then rolls back once it is gone.
    await admin.query("INSERT INTO social_accounts (account_id, sui_address, callsign) VALUES ($1, $2, 'wallet_kept')", [uuid(0x3100), wallet(0x3100)]);
    await admin.query("BEGIN");
    await assert.rejects(
      admin.query(await readFile(new URL("0058_social_wallet_sign_in.down.sql", MIGRATIONS), "utf8")),
      /wallet-only social accounts exist/,
    );
    await admin.query("ROLLBACK");
    await admin.query("DELETE FROM social_accounts WHERE account_id = $1", [uuid(0x3100)]);

    // Roll the reversible social schema back, newest first.
    const applied = await socialMigrations();
    assert.deepEqual(applied.slice(0, 2), ["0054_social_schema", "0055_social_feed_entries"]);
    for (const name of [...applied].reverse()) {
      await admin.query("BEGIN");
      await admin.query(await readFile(new URL(`${name}.down.sql`, MIGRATIONS), "utf8"));
      await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = $1", [name]);
      await admin.query("COMMIT");
    }
    assert.deepEqual((await relations()).filter((row) => row.name.startsWith("public.")), []);
    const leftovers = await rows(
      admin,
      `SELECT tgname FROM pg_trigger WHERE tgname LIKE '%social%'
       UNION ALL SELECT proname FROM pg_proc WHERE proname LIKE 'social\\_%'`,
    );
    assert.deepEqual(leftovers, []);
    // A Mission Control callsign works as before once the guard is gone.
    await insertProfile(admin, 1, "after_down");
    // Without 0058 a sign-in challenge is refused again, and none is left behind.
    assert.equal((await rows(admin, "SELECT 1 FROM mission_control_wallet_challenges WHERE action = 'sign_in'")).length, 0);
    await assert.rejects(signInChallenge(2), { code: "23514", constraint: "mission_control_wallet_challenges_action_check" });

    assert.deepEqual(await migrateDatabase(admin), currentMigrations);
    assert.deepEqual((await relations()).map((row) => row.name), names);
    await assert.rejects(insertNewAccount(admin, 1, "after_down"), { code: "23505", constraint: "social_accounts_callsign_taken" });
    await signInChallenge(3);
  } finally {
    await admin.end();
    await drop();
  }
});

test("UI-06 (0062): the account's own name and picture lead the public identity; the migration goes down and up again", { skip }, async () => {
  const { admin, url, drop } = await freshDatabase();
  try {
    const profileId = await insertProfile(admin, 62, "member_62");
    await admin.query("UPDATE mission_control_profiles SET display_name = 'Profile Name', x_avatar_reference = 'https://pbs.twimg.com/m.png' WHERE profile_id = $1", [profileId]);
    const member = await insertProfileAccount(admin, 62, profileId);
    const fresh = await insertNewAccount(admin, 62, "fresh_62");
    await admin.query("UPDATE social_accounts SET display_name = 'Fresh', x_avatar_url = 'https://pbs.twimg.com/f.png' WHERE account_id = $1", [fresh]);
    const identity = async (accountId: string) =>
      (await rows<{ display_name: string | null; avatar_url: string | null; verified: boolean }>(
        admin, "SELECT display_name, avatar_url, verified FROM social_account_identities WHERE account_id = $1", [accountId],
      ))[0];
    // No choice yet: the source's name and picture.
    assert.deepEqual(await identity(member), { display_name: "Profile Name", avatar_url: "https://pbs.twimg.com/m.png", verified: true });
    await admin.query("UPDATE social_accounts SET display_name = 'Chosen', picture = 'upload', picture_url = 'https://blob.test/p.webp' WHERE account_id = $1", [member]);
    await admin.query("UPDATE social_accounts SET picture = 'none' WHERE account_id = $1", [fresh]);
    assert.deepEqual(await identity(member), { display_name: "Chosen", avatar_url: "https://blob.test/p.webp", verified: true });
    assert.deepEqual(await identity(fresh), { display_name: "Fresh", avatar_url: null, verified: false });
    // An upload needs its URL, an https one; the URL goes with the upload.
    for (const bad of [
      "UPDATE social_accounts SET picture = 'upload', picture_url = NULL WHERE account_id = $1",
      "UPDATE social_accounts SET picture = 'none', picture_url = 'https://blob.test/p.webp' WHERE account_id = $1",
      "UPDATE social_accounts SET picture = 'upload', picture_url = 'http://blob.test/p.webp' WHERE account_id = $1",
      "UPDATE social_accounts SET picture = 'avatar' WHERE account_id = $1",
    ]) {
      await assert.rejects(admin.query(bad, [fresh]), { code: "23514" }, bad);
    }

    // Down: the identity reads the sources again and the columns are gone. 0072's search view reads
    // the picture columns, and 0168's savers view reads 0072's watchlist, so they go down first
    // (newest first) and come back with 0062.
    await admin.query("BEGIN");
    await admin.query(await readFile(new URL("0168_social_presale_savers.down.sql", MIGRATIONS), "utf8"));
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0168_social_presale_savers'");
    await admin.query(await readFile(new URL("0072_social_watchlist_search.down.sql", MIGRATIONS), "utf8"));
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0072_social_watchlist_search'");
    await admin.query(await readFile(new URL("0062_social_profile_edit.down.sql", MIGRATIONS), "utf8"));
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0062_social_profile_edit'");
    await admin.query("COMMIT");
    assert.deepEqual(await identity(member), { display_name: "Profile Name", avatar_url: "https://pbs.twimg.com/m.png", verified: true });
    assert.deepEqual(await identity(fresh), { display_name: "Fresh", avatar_url: "https://pbs.twimg.com/f.png", verified: false });
    assert.deepEqual(await rows(admin, "SELECT column_name FROM information_schema.columns WHERE table_name = 'social_accounts' AND column_name IN ('picture', 'picture_url', 'profile_updated_at')"), []);
    // Up again.
    assert.deepEqual(await migrateDatabase(admin), ["0062_social_profile_edit", "0072_social_watchlist_search", "0168_social_presale_savers"]);
    assert.deepEqual(await identity(member), { display_name: "Profile Name", avatar_url: "https://pbs.twimg.com/m.png", verified: true });
    const replica = createRuntimePool(urlAs(url, "blast_replica"), { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 1, statementTimeoutMs: 5_000 }, "ui06-schema-replica");
    try {
      // The replica still reads the identity (the view keeps its grants and its owner's rights).
      assert.equal((await replica.query("SELECT count(*)::int AS n FROM social_account_identities")).rows[0]?.n, 2);
    } finally {
      await replica.end();
    }
  } finally {
    await admin.end();
    await drop();
  }
});

test("UI-12 (0072): one star per account and presale; search finds public accounts and members only; down and up again", { skip }, async () => {
  const { admin, url, drop } = await freshDatabase();
  try {
    const kai = await insertNewAccount(admin, 72, "kai_72");
    await admin.query("UPDATE social_accounts SET display_name = 'Kai Seventy' WHERE account_id = $1", [kai]);
    const presale = `0x${"72".repeat(32)}`;
    await admin.query("INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, $2)", [kai, presale]);
    await assert.rejects(admin.query("INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, $2)", [kai, presale]), { code: "23505" });
    await assert.rejects(admin.query("INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, 'MRDN')", [kai]), { code: "23514" });
    await assert.rejects(admin.query("INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, $2)", [uuid(0x7272), presale]), { code: "23503" });

    // Search rows: a public new account, a member without an account row, a member who renamed itself on Blast, a private one.
    await insertProfile(admin, 72, "crew_72");
    await admin.query("UPDATE mission_control_profiles SET display_name = 'Crew Name' WHERE callsign = 'crew_72'");
    const renamed = await insertProfile(admin, 73, "renamed_73");
    await admin.query("UPDATE mission_control_profiles SET display_name = 'Old Name' WHERE profile_id = $1", [renamed]);
    const renamedAccount = await insertProfileAccount(admin, 73, renamed);
    await admin.query("UPDATE social_accounts SET display_name = 'New Name' WHERE account_id = $1", [renamedAccount]);
    const hidden = await insertNewAccount(admin, 74, "hidden_74");
    await admin.query("UPDATE social_accounts SET privacy = 'private' WHERE account_id = $1", [hidden]);
    const search = () => rows<{ callsign: string; display_name: string | null; haystack: string }>(
      admin, "SELECT callsign, display_name, haystack FROM social_account_search ORDER BY callsign, haystack",
    );
    assert.deepEqual(await search(), [
      { callsign: "crew_72", display_name: "Crew Name", haystack: "crew_72 crew name" },
      { callsign: "kai_72", display_name: "Kai Seventy", haystack: "kai_72 kai seventy" },
      // Two rows for the renamed member: the profile's haystack (the reader re-checks it) and the Blast name's.
      { callsign: "renamed_73", display_name: "New Name", haystack: " new name" },
      { callsign: "renamed_73", display_name: "New Name", haystack: "renamed_73 old name" },
    ]);
    // A member who goes private leaves search with every row.
    await admin.query("UPDATE social_accounts SET privacy = 'private' WHERE account_id = $1", [renamedAccount]);
    assert.deepEqual((await search()).map((row) => row.callsign), ["crew_72", "kai_72"]);

    const replica = createRuntimePool(urlAs(url, "blast_replica"), { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 1, statementTimeoutMs: 5_000 }, "ui12-schema-replica");
    try {
      // The replica reads the search view (owner's rights) but never the watchlist or a profile.
      assert.equal((await replica.query("SELECT count(*)::int AS n FROM social_account_search")).rows[0]?.n, 2);
      await assert.rejects(replica.query("SELECT 1 FROM social_watchlist"), { code: "42501" });
      await assert.rejects(replica.query("SELECT 1 FROM mission_control_profiles"), { code: "42501" });
    } finally {
      await replica.end();
    }

    // Down: the view, its indexes and the watchlist are gone; up again. 0168's savers view reads
    // the watchlist, so it goes down first (newest first) and comes back with it.
    await admin.query("BEGIN");
    await admin.query(await readFile(new URL("0168_social_presale_savers.down.sql", MIGRATIONS), "utf8"));
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0168_social_presale_savers'");
    await admin.query(await readFile(new URL("0072_social_watchlist_search.down.sql", MIGRATIONS), "utf8"));
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0072_social_watchlist_search'");
    await admin.query("COMMIT");
    assert.deepEqual(await rows(admin, "SELECT relname FROM pg_class WHERE relname IN ('social_watchlist', 'social_account_search', 'social_accounts_search_trgm_idx', 'social_profiles_search_trgm_idx')"), []);
    assert.deepEqual(await migrateDatabase(admin), ["0072_social_watchlist_search", "0168_social_presale_savers"]);
    assert.equal((await rows(admin, "SELECT 1 FROM social_account_search")).length, 2);
    assert.equal((await rows(admin, "SELECT 1 FROM pg_class WHERE relname IN ('social_presale_savers', 'social_watchlist_presale_idx')")).length, 2);
  } finally {
    await admin.end();
    await drop();
  }
});

test("withdraw to another chain (0100): a withdrawal is one row per key and digest, built with its bytes or refused with a code, moved only forward from the chain and Circle, never edited or deleted; the sponsor takes a bridge_withdraw intent; down and up again", { skip }, async () => {
  const { admin, drop } = await freshDatabase();
  const asWeb = async (sql: string, values: unknown[] = []) => {
    const own = await admin.connect();
    try {
      await own.query("BEGIN");
      await own.query("SET LOCAL ROLE blast_web");
      return await own.query(sql, values);
    } finally {
      await own.query("ROLLBACK").catch(() => undefined);
      own.release();
    }
  };
  try {
    const ada = await insertNewAccount(admin, 101, "bridge_ada");
    // Base58 has no 0: a digit 0 in the suffix reads as z.
    const digest = (n: number) => `${"4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkL".slice(0, 40)}${String(n).padStart(3, "1").replace(/0/g, "z")}`;
    const key = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
    const now = Date.now();
    const evmHook = Buffer.concat([Buffer.from("cctp-forward"), Buffer.alloc(20)]);
    const solanaHook = Buffer.concat([evmHook.subarray(0, 28), Buffer.from([0, 0, 0, 33, 1]), Buffer.alloc(32, 7)]);
    const recipient = `0x${"1e".repeat(20)}`;
    const insert = (n: number, overrides: Record<string, unknown> = {}) => {
      const row = {
        key: key(n), destination: "base", recipient, mint_recipient: `0x${recipient.slice(2).padStart(64, "0")}`,
        amount: "5000000", max_fee: "54622", hook: evmHook as Buffer, fee_payer: "blast" as string | null, reservation_id: uuid(0x10100 + n) as string | null,
        tx_bytes: Buffer.from([n]) as Buffer | null, digest: digest(n) as string | null, expires_at_ms: (now + 110_000) as number | null,
        state: "built", failure_code: null as string | null, destination_tx_hash: null as string | null, burned_at_ms: null as number | null,
        delivered_at_ms: null as number | null, ...overrides,
      };
      return admin.query(
        `INSERT INTO social_bridge_withdrawals (withdrawal_id, account_id, idempotency_key, sender, destination, recipient, mint_recipient, amount, max_fee,
           hook, fee_payer, reservation_id, tx_bytes, digest, expires_at_ms, state, failure_code, destination_tx_hash, created_at_ms, burned_at_ms, delivered_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
        [uuid(0x10100 + n), ada, row.key, wallet(0x101), row.destination, row.recipient, row.mint_recipient, row.amount, row.max_fee, row.hook, row.fee_payer,
          row.reservation_id, row.tx_bytes, row.digest, row.expires_at_ms, row.state, row.failure_code, row.destination_tx_hash, now, row.burned_at_ms, row.delivered_at_ms],
      );
    };
    const refused = { state: "failed", fee_payer: null, reservation_id: null, tx_bytes: null, digest: null, expires_at_ms: null };
    const solana = { destination: "solana", recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", hook: solanaHook };
    const evmTx = `0x${"ab".repeat(32)}`;
    assert.equal((await insert(1)).rowCount, 1, "built, sponsored");
    assert.equal((await insert(2, { fee_payer: "wallet", reservation_id: null, ...solana })).rowCount, 1, "built for Solana, the wallet pays");
    assert.equal((await insert(3, { ...refused, failure_code: "insufficient_balance" })).rowCount, 1, "refused before anything was built");
    assert.equal((await insert(4, { state: "burned", burned_at_ms: now + 2_000 })).rowCount, 1, "burned on Sui");
    assert.equal((await insert(5, { state: "delivered", burned_at_ms: now + 2_000, delivered_at_ms: now + 60_000, destination_tx_hash: evmTx })).rowCount, 1, "delivered by Circle");
    assert.equal((await insert(6, { state: "failed", failure_code: "expired" })).rowCount, 1, "built, never executed");
    for (const [n, bad] of [
      [7, { tx_bytes: null }],
      [8, { ...refused }],
      [9, { ...refused, failure_code: "expired" }],
      [10, { state: "failed", failure_code: "dry_run_failed" }],
      [11, { state: "burned" }],
      [12, { state: "delivered", burned_at_ms: now + 1, delivered_at_ms: now + 2 }],
      [13, { state: "delivered", burned_at_ms: now + 1, destination_tx_hash: evmTx }],
      [14, { fee_payer: "wallet" }],
      [15, { max_fee: "5000000" }],
      [16, { amount: "0", max_fee: "0" }],
      [17, { key: "not-a-uuid" }],
      [18, { recipient: recipient.replace("1e", "1E") }],
      [19, { recipient: `0x${"0".repeat(40)}` }],
      [20, { destination: "solana" }],
      [21, { hook: solanaHook }],
      [22, { ...solana, hook: evmHook }],
      [23, { destination: "sui" }],
      [24, { mint_recipient: `0x${"0".repeat(64)}` }],
      [25, { state: "delivered", burned_at_ms: now + 1, delivered_at_ms: now + 2, destination_tx_hash: digest(1) }],
      [26, { ...solana, state: "delivered", burned_at_ms: now + 1, delivered_at_ms: now + 2, destination_tx_hash: evmTx }],
      [27, { state: "burned", burned_at_ms: now - 1 }],
      [28, { digest: "not-a-digest" }],
      [29, { ...refused, failure_code: "MoveAbort(0x2::coin, 7)" }],
    ] as const) {
      await assert.rejects(insert(n, bad), { code: "23514" }, JSON.stringify(bad));
    }
    await assert.rejects(insert(30, { key: key(1) }), { code: "23505", constraint: "social_bridge_withdrawals_key" });
    await assert.rejects(insert(31, { digest: digest(1) }), { code: "23505", constraint: "social_bridge_withdrawals_digest_idx" });

    // The web runtime moves a row forward (rolled back here) and has no DELETE.
    assert.equal((await asWeb("UPDATE social_bridge_withdrawals SET state = 'burned', burned_at_ms = $2 WHERE withdrawal_id = $1", [uuid(0x10101), now + 1_000])).rowCount, 1);
    assert.equal(
      (await asWeb("UPDATE social_bridge_withdrawals SET state = 'delivered', delivered_at_ms = $2, destination_tx_hash = $3 WHERE withdrawal_id = $1", [uuid(0x10104), now + 9_000, evmTx])).rowCount,
      1,
    );
    assert.equal((await asWeb("UPDATE social_bridge_withdrawals SET state = 'failed', failure_code = 'mismatch' WHERE withdrawal_id = $1", [uuid(0x10101)])).rowCount, 1);
    await assert.rejects(asWeb("DELETE FROM social_bridge_withdrawals WHERE withdrawal_id = $1", [uuid(0x10101)]), { code: "42501" });
    for (const [sql, values, constraint] of [
      ["UPDATE social_bridge_withdrawals SET amount = 1 WHERE withdrawal_id = $1", [uuid(0x10101)], "social_bridge_withdrawals_never_edited"],
      ["UPDATE social_bridge_withdrawals SET recipient = '0x1111111111111111111111111111111111111111' WHERE withdrawal_id = $1", [uuid(0x10101)], "social_bridge_withdrawals_never_edited"],
      ["UPDATE social_bridge_withdrawals SET digest = $2 WHERE withdrawal_id = $1", [uuid(0x10101), digest(40)], "social_bridge_withdrawals_never_edited"],
      ["UPDATE social_bridge_withdrawals SET state = 'built', burned_at_ms = NULL WHERE withdrawal_id = $1", [uuid(0x10104)], "social_bridge_withdrawals_forward"],
      ["UPDATE social_bridge_withdrawals SET state = 'failed', failure_code = 'mismatch', burned_at_ms = NULL WHERE withdrawal_id = $1", [uuid(0x10104)], "social_bridge_withdrawals_forward"],
      ["UPDATE social_bridge_withdrawals SET state = 'built', failure_code = NULL WHERE withdrawal_id = $1", [uuid(0x10106)], "social_bridge_withdrawals_forward"],
      ["UPDATE social_bridge_withdrawals SET failure_code = 'mismatch' WHERE withdrawal_id = $1", [uuid(0x10106)], "social_bridge_withdrawals_forward"],
      ["UPDATE social_bridge_withdrawals SET destination_tx_hash = $2 WHERE withdrawal_id = $1", [uuid(0x10105), `0x${"cd".repeat(32)}`], "social_bridge_withdrawals_forward"],
      ["UPDATE social_bridge_withdrawals SET burned_at_ms = burned_at_ms + 1 WHERE withdrawal_id = $1", [uuid(0x10104)], "social_bridge_withdrawals_forward"],
    ] as const) {
      await assert.rejects(admin.query(sql, [...values]), { code: "23514", constraint }, sql);
      await assert.rejects(asWeb(sql, [...values]), { code: "23514", constraint }, `${sql} as blast_web`);
    }

    // The sponsor's bridge_withdraw intent names no presale; 0100's down refuses while a withdrawal or such a reservation exists.
    const own = await admin.connect();
    try {
      const reserve = (intent: string, presaleId: string | null) =>
        own.query(
          `INSERT INTO presale_sponsor_reservations (privy_did, sender, presale_id, intent, gas_budget, expires_at, pool_deadline)
           VALUES ('did:privy:bridge-101', $1, $2, $3, 2000000, now() + interval '2 minutes', now() + interval '5 seconds')`,
          [wallet(0x101), presaleId, intent],
        );
      const attempt = async (run: () => Promise<unknown>) => {
        await own.query("SAVEPOINT attempt");
        try {
          return await run();
        } finally {
          await own.query("ROLLBACK TO SAVEPOINT attempt");
        }
      };
      await own.query("BEGIN");
      await reserve("bridge_withdraw", null);
      await assert.rejects(attempt(() => reserve("bridge_withdraw", wallet(0x51))), { code: "23514", constraint: "presale_sponsor_reservations_presale_by_intent" });
      const down = await readFile(new URL("0100_social_bridge_withdrawals.down.sql", MIGRATIONS), "utf8");
      await assert.rejects(attempt(() => own.query(down)), /withdrawals to another chain exist/);
      await own.query("DELETE FROM social_bridge_withdrawals");
      await assert.rejects(attempt(() => own.query(down)), /sponsored withdrawal reservations exist/);
      await own.query("DELETE FROM presale_sponsor_reservations WHERE intent = 'bridge_withdraw'");
      await own.query(down);
      assert.deepEqual(
        (await own.query("SELECT to_regclass('social_bridge_withdrawals') AS t, to_regproc('social_bridge_withdrawals_check_update') AS f")).rows,
        [{ t: null, f: null }],
      );
      await assert.rejects(attempt(() => reserve("bridge_withdraw", null)), { code: "23514", constraint: "presale_sponsor_reservations_intent_check" });
      await reserve("trade", null);
      await own.query(await readFile(new URL("0100_social_bridge_withdrawals.up.sql", MIGRATIONS), "utf8"));
      await reserve("bridge_withdraw", null);
      await own.query("ROLLBACK");
    } finally {
      own.release();
    }
  } finally {
    await admin.end();
    await drop();
  }
});
