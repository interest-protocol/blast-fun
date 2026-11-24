import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { Pool, PoolClient } from "pg";

import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { markOnboardingShown } from "@blast/server/modules/social/onboarding/repository.ts";
import type { SocialBackfillCounts } from "./backfill.ts";
import { uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * Social feed T-015 (AC-028, AC-029, REQ-006, SC-08 at fixture scale):
 * `npm run social:operator -- backfill` as an operator runs it, as a child
 * process against a disposable database (never a remote one). Members join
 * with `member`, `sticky`, `team` and `creator` codes.
 */
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OPERATOR_ID = "ops.social-backfill-test";
const TOKEN = "social-backfill-integration-token-32-chars";
const APPLICATION = "t015-backfill";
const ENV = {
  MISSION_CONTROL_OPERATOR_ALLOWED_ID: OPERATOR_ID,
  MISSION_CONTROL_OPERATOR_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
  BLAST_OPERATOR_ID: OPERATOR_ID,
  BLAST_OPERATOR_TOKEN: TOKEN,
};
const POOL_SETTINGS = {
  connectionTimeoutMs: 5_000,
  idleInTransactionMs: 10_000,
  idleTimeoutMs: 1_000,
  lockTimeoutMs: 5_000,
  max: 12,
  statementTimeoutMs: 10_000,
};

type CliResult = { code: number; stdout: string; stderr: string };
/** The running test's own database; `withDatabase` sets it. */
let testDatabaseUrl: string | null = null;
type Printed = { command: string; logId: string; result: SocialBackfillCounts };

/** The CLI on the disposable database, tagged so a test can see its session wait. */
async function cli(args: readonly string[]): Promise<CliResult> {
  assert.ok(testDatabaseUrl);
  const url = new URL(testDatabaseUrl);
  url.searchParams.set("application_name", APPLICATION);
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: url.toString(), ...ENV };
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", "scripts/social-operator.ts", ...args],
      { cwd: ROOT, env },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function backfill(...args: string[]): Promise<Printed> {
  const result = await cli(["backfill", ...args]);
  assert.equal(result.code, 0, result.stderr);
  const printed = JSON.parse(result.stdout) as Printed;
  assert.equal(printed.command, "backfill");
  return printed;
}

const did = (n: number) => `did:privy:backfill-${n}`;

/** Mission Control members, numbered; each has a Privy identity, as a signed-up member does. */
async function insertMembers(db: Pool, numbers: readonly number[]): Promise<void> {
  await db.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign,
       disclosure_version, disclosure_accepted_at
     )
     SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'did:privy:backfill-' || n,
       'x-backfill-' || n, '0x' || lpad(to_hex(n + 4096), 64, '0'), 'wallet-' || n, 'pilot_' || n,
       'fixture-v1', now()
     FROM unnest($1::int[]) AS n`,
    [numbers],
  );
  await db.query(
    `INSERT INTO mission_control_account_identities (profile_id, provider, provider_subject, verified_at)
     SELECT ('00000000-0000-4000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, 'privy', 'did:privy:backfill-' || n, now()
     FROM unnest($1::int[]) AS n`,
    [numbers],
  );
}

type CodeKind = "member" | "sticky" | "team" | "creator";
let codeSequence = 0;
let seedCreator: string | null = null;

/** One referral of `recruit` by `referrer` through a fresh code of `kind`. */
async function insertReferral(db: Pool, recruit: number, referrer: number, kind: CodeKind): Promise<void> {
  codeSequence += 1;
  if (kind === "creator" && !seedCreator) {
    seedCreator = randomUUID();
    await db.query(
      `INSERT INTO mission_control_seed_creators (seed_creator_id, season_id, display_name, expected_x_handle)
       VALUES ($1, 'season-zero', 'Seed Creator', 'seed_creator')`,
      [seedCreator],
    );
    await db.query(
      `INSERT INTO mission_control_seed_code_groups (seed_code_group_id, seed_creator_id, group_label)
       VALUES ($1, $1, 'Seed Creator')`,
      [seedCreator],
    );
  }
  const codeId = randomUUID();
  await db.query(
    `INSERT INTO mission_control_invitation_codes (
       code_id, season_id, lookup_key_version, lookup_hmac, encrypted_display, encryption_iv, encryption_tag,
       encryption_key_version, enabled, code_kind, owner_profile_id, seed_creator_id, seed_code_group_id, sticky_position
     ) VALUES ($1, 'season-zero', 'test-v1', $2, 'source', 'aXY=', 'dGFn', 'test-v1', TRUE, $3, $4, $5, $5, $6)`,
    [
      codeId,
      createHash("sha256").update(`backfill-code-${codeSequence}`).digest("hex"),
      kind,
      kind === "member" ? uuid(referrer) : null,
      kind === "creator" ? seedCreator : null,
      kind === "sticky" ? 1 : null,
    ],
  );
  await db.query(
    `INSERT INTO mission_control_referrals (recruited_profile_id, referrer_profile_id, source_code_id, created_at)
     VALUES ($1, $2, $3, now())`,
    [uuid(recruit), uuid(referrer), codeId],
  );
}

async function withDatabase(body: (db: Pool) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  testDatabaseUrl = database.url;
  const db = createPool(database.url, { max: 6 });
  codeSequence = 0;
  seedCreator = null;
  try {
    await body(db);
  } finally {
    await db.end();
    await database.drop();
    testDatabaseUrl = null;
  }
}

type AccountRow = {
  account_id: string;
  profile_id: string | null;
  privy_did: string | null;
  callsign: string | null;
  onboarded_at: Date | null;
  onboarding_shown_at: Date | null;
  default_follows_applied_at: Date | null;
  launch_code_follow_applied_at: Date | null;
};

async function snapshot(db: Pool): Promise<{ accounts: AccountRow[]; follows: unknown[] }> {
  const [accounts, follows] = await Promise.all([
    db.query<AccountRow>(
      `SELECT account_id, profile_id, privy_did, callsign, onboarded_at, onboarding_shown_at,
         default_follows_applied_at, launch_code_follow_applied_at
       FROM social_accounts ORDER BY account_id`,
    ),
    db.query("SELECT * FROM social_follows ORDER BY follower_account_id, target_kind, target_id"),
  ]);
  return { accounts: accounts.rows, follows: follows.rows };
}

const memberNumber = (profileId: string) => Number.parseInt(profileId.split("-")[4]!, 16);

/** `recruit -> referrer source` (member numbers) for every follow. */
async function followPairs(db: Pool): Promise<string[]> {
  const { rows } = await db.query<{ follower: string; target: string; source: string }>(
    `SELECT follower.profile_id AS follower, target.profile_id AS target, f.source
     FROM social_follows f
     JOIN social_accounts follower ON follower.account_id = f.follower_account_id
     JOIN social_accounts target ON target.account_id::text = f.target_id`,
  );
  return rows.map((row) => `${memberNumber(row.follower)} -> ${memberNumber(row.target)} ${row.source}`).sort();
}

async function log(db: Pool): Promise<{ operator_id: string; action: string; target: string; before: unknown; after: unknown; reason: string | null }[]> {
  return (await db.query(
    "SELECT operator_id, action, target, before, after, reason FROM social_operator_log ORDER BY acted_at, log_id",
  )).rows;
}

const ZERO_CHANGES = { accounts_created: 0, recruits_marked: 0, launch_code_follows_created: 0 };

/**
 * Referrers 1 and 2; recruits 10–14 through `member` codes, 20–22 through
 * `sticky`, `team` and `creator` codes; members 30–32 joined with no code.
 * Member 13 already finished onboarding and unfollowed its referrer (marker
 * set, no follow). Member 14 already has an account row, unmarked. A new
 * Blast Account (no profile) must stay untouched.
 */
const MEMBER_REFERRALS: readonly [number, number][] = [[10, 1], [11, 1], [12, 2], [13, 2], [14, 1]];
const EXCLUDED_REFERRALS: readonly [number, number, CodeKind][] = [[20, 1, "sticky"], [21, 2, "team"], [22, 1, "creator"]];
const PLAIN = [30, 31, 32];
const NEW_ACCOUNT = uuid(0xe1);

async function seedEveryKind(db: Pool): Promise<void> {
  await insertMembers(db, [1, 2, ...MEMBER_REFERRALS.map(([recruit]) => recruit), ...EXCLUDED_REFERRALS.map(([recruit]) => recruit), ...PLAIN]);
  for (const [recruit, referrer] of MEMBER_REFERRALS) await insertReferral(db, recruit, referrer, "member");
  for (const [recruit, referrer, kind] of EXCLUDED_REFERRALS) await insertReferral(db, recruit, referrer, kind);
  await db.query(
    `INSERT INTO social_accounts (account_id, profile_id, onboarding_shown_at, onboarded_at,
       default_follows_applied_at, launch_code_follow_applied_at)
     VALUES ($1, $2, '2026-09-01Z', '2026-09-01Z', '2026-09-01Z', '2026-09-01Z')`,
    [uuid(0xa13), uuid(13)],
  );
  await db.query("INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2)", [uuid(0xa14), uuid(14)]);
  await db.query(
    "INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES ($1, 'did:privy:backfill-new', 'new_person')",
    [NEW_ACCOUNT],
  );
}

test("T-015-AC-1/AC-2 (AC-028, AC-029): one account per profile, one follow per member referral; a second run creates nothing", { skip }, async () => {
  await withDatabase(async (db) => {
    await seedEveryKind(db);
    const profiles = 2 + MEMBER_REFERRALS.length + EXCLUDED_REFERRALS.length + PLAIN.length;
    const before = await snapshot(db);

    const first = await backfill("--batch-size", "4", "--reason", "release");
    const firstCounts: SocialBackfillCounts = {
      profiles_scanned: profiles,
      accounts_created: profiles - 2,
      member_referrals_scanned: MEMBER_REFERRALS.length,
      recruits_marked: 4,
      launch_code_follows_created: 4,
      // 4 account batches of at most 4 profiles, then 2 referral batches of two transactions each.
      batches: 4 + 2 * 2,
    };
    assert.deepEqual(first.result, firstCounts);

    const after = await snapshot(db);
    const memberAccounts = after.accounts.filter((row) => row.profile_id !== null);
    assert.equal(memberAccounts.length, profiles, "one account per profile");
    assert.equal(new Set(memberAccounts.map((row) => row.profile_id)).size, profiles);
    for (const row of memberAccounts) {
      if (row.profile_id === uuid(13)) continue;
      assert.equal(row.onboarded_at, null, `${row.profile_id} is not onboarded`);
      assert.equal(row.onboarding_shown_at, null);
      assert.equal(row.default_follows_applied_at, null, "default follows stay for onboarding");
    }
    const unchanged = (id: string) => [before, after].map((state) => state.accounts.find((row) => row.account_id === id));
    for (const id of [NEW_ACCOUNT, uuid(0xa13)]) {
      const [was, is] = unchanged(id);
      assert.deepEqual(is, was, `${id} is untouched`);
    }
    assert.equal(unchanged(uuid(0xa14))[1]?.profile_id, uuid(14), "an existing row is reused, not duplicated");

    // AC-028: one launch-code follow per member referral not yet applied. AC-029: none through other codes.
    assert.deepEqual(await followPairs(db), ["10 -> 1 launch_code", "11 -> 1 launch_code", "12 -> 2 launch_code", "14 -> 1 launch_code"]);
    const marked = (await db.query<{ profile_id: string }>(
      "SELECT profile_id FROM social_accounts WHERE launch_code_follow_applied_at IS NOT NULL ORDER BY profile_id",
    )).rows.map((row) => memberNumber(row.profile_id));
    assert.deepEqual(marked, [10, 11, 12, 13, 14], "only member recruits carry the marker");

    assert.deepEqual(await log(db), [
      { operator_id: OPERATOR_ID, action: "backfill", target: "*", before: null, after: { ...firstCounts, completed: true }, reason: "release" },
    ]);

    // The second run, at the default batch size, changes nothing and reports zero.
    const second = await backfill();
    assert.deepEqual(second.result, {
      profiles_scanned: profiles,
      member_referrals_scanned: MEMBER_REFERRALS.length,
      ...ZERO_CHANGES,
      batches: 1 + 2,
    });
    assert.deepEqual(await snapshot(db), after, "accounts and follows are identical after a second run");
    const logged = await log(db);
    assert.equal(logged.length, 2);
    assert.deepEqual(logged[1]!.after, { ...second.result, completed: true });

    // Onboarding later never re-adds a backfilled follow the recruit removed (the marker).
    const recruit = after.accounts.find((row) => row.profile_id === uuid(10))!;
    await db.query("DELETE FROM social_follows WHERE follower_account_id = $1", [recruit.account_id]);
    await withTransaction(db, (transaction) => markOnboardingShown(transaction.forModule("social"), recruit.account_id));
    assert.deepEqual(await followPairs(db), ["11 -> 1 launch_code", "12 -> 2 launch_code", "14 -> 1 launch_code"]);
    assert.deepEqual((await backfill()).result, { profiles_scanned: profiles, member_referrals_scanned: 5, ...ZERO_CHANGES, batches: 3 });
    assert.deepEqual(await followPairs(db), ["11 -> 1 launch_code", "12 -> 2 launch_code", "14 -> 1 launch_code"]);
  });
});

test("T-015-AC-1 (AC-028): a run concurrent with live GET /me account creation leaves exactly one account per profile", { skip }, async () => {
  await withDatabase(async (db) => {
    const MEMBERS = Array.from({ length: 150 }, (_, index) => index + 1);
    await insertMembers(db, MEMBERS);
    // Every third member was recruited by member 1 with its member code.
    const recruits = MEMBERS.filter((n) => n > 1 && n % 3 === 0);
    for (const recruit of recruits) await insertReferral(db, recruit, 1, "member");

    // Accounts that `GET /me` creates carry a recognizable id, so the backfill's count can be checked exactly.
    let meSequence = 0;
    const meId = () => `00000000-0000-4000-9000-${(++meSequence).toString(16).padStart(12, "0")}`;
    const web = createRuntimePool(urlAs(testDatabaseUrl!, "blast_web"), POOL_SETTINGS, "social-backfill-test");
    try {
      const accounts = new PostgresSocialAccounts(() => web, { createId: meId });
      const order = [...MEMBERS].sort(() => Math.random() - 0.5);
      const running = backfill("--batch-size", "2");
      // Members sign in while the backfill is part-way through its account batches.
      await rowsAtLeast(db, 10);
      const resolved = await Promise.all(order.map(async (n) => [n, await accounts.resolve(did(n))] as const));
      const run = await running;

      const rows = (await db.query<{ account_id: string; profile_id: string }>(
        "SELECT account_id, profile_id FROM social_accounts",
      )).rows;
      assert.equal(rows.length, MEMBERS.length, "exactly one account per profile");
      const byProfile = new Map(rows.map((row) => [row.profile_id, row.account_id]));
      for (const [n, account] of resolved) {
        assert.equal(account?.kind, "member");
        assert.equal(account?.account_id, byProfile.get(uuid(n)), `GET /me for member ${n} answers the stored account`);
      }
      const createdByMe = rows.filter((row) => row.account_id.startsWith("00000000-0000-4000-9000-")).length;
      assert.ok(createdByMe > 0 && createdByMe < MEMBERS.length, `the two writers overlapped (GET /me created ${createdByMe})`);
      assert.equal(run.result.accounts_created, MEMBERS.length - createdByMe, "the backfill counts only the rows it created");
      assert.equal(run.result.profiles_scanned, MEMBERS.length);
      assert.equal(run.result.recruits_marked, recruits.length);
      assert.equal(run.result.launch_code_follows_created, recruits.length);
      assert.deepEqual(
        await followPairs(db),
        recruits.map((n) => `${n} -> 1 launch_code`).sort(),
      );

      const after = await snapshot(db);
      const second = await backfill();
      assert.deepEqual(second.result, {
        profiles_scanned: MEMBERS.length,
        member_referrals_scanned: recruits.length,
        ...ZERO_CHANGES,
        batches: 1 + 2,
      });
      assert.deepEqual(await snapshot(db), after);
    } finally {
      await web.end();
    }
  });
});

async function rowsAtLeast(db: Pool, count: number): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM social_accounts");
    if (rows[0]!.n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`social_accounts never reached ${count} rows`);
}

/** Waits until the backfill's session waits on a lock that backend `holder` holds. */
async function backfillBlockedBy(db: Pool, holder: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const { rowCount } = await db.query(
      "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND $2::int = ANY (pg_blocking_pids(pid))",
      [APPLICATION, holder],
    );
    if (rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`the backfill never waited on backend ${holder}`);
}

test("T-015 (AC-028): the backfill waits for an in-flight account insert and an in-flight onboarding, and duplicates neither", { skip }, async () => {
  await withDatabase(async (db) => {
    await insertMembers(db, [1, 2, 3]);
    await insertReferral(db, 3, 1, "member");
    // Members 1 and 3 already resolved; member 2 has no row.
    await db.query("INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2), ($3, $4)", [
      uuid(0xa1), uuid(1), uuid(0xa3), uuid(3),
    ]);

    // GET /me's insert for member 2, in flight (uncommitted) when the backfill starts.
    const inFlight: PoolClient = await db.connect();
    try {
      await inFlight.query("BEGIN");
      await inFlight.query(
        "INSERT INTO social_accounts (account_id, profile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [uuid(0xa2), uuid(2)],
      );
      const inFlightPid = (await inFlight.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      // Onboarding of recruit 3, in flight: it holds the account row and applies the launch-code follow.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: (pid: number) => void;
      const onboardingPid = new Promise<number>((resolve) => {
        started = resolve;
      });
      const onboarding = withTransaction(db, async (transaction) => {
        await markOnboardingShown(transaction.forModule("social"), uuid(0xa3));
        started((await transaction.read<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
        await gate;
      });

      const running = backfill("--batch-size", "2");
      await backfillBlockedBy(db, inFlightPid);
      await inFlight.query("COMMIT");
      await backfillBlockedBy(db, await onboardingPid);
      release();
      await onboarding;
      const result = (await running).result;

      assert.equal(result.accounts_created, 0, "member 2's row came from GET /me");
      assert.equal(result.recruits_marked, 0, "onboarding applied recruit 3's follow first");
      assert.equal(result.launch_code_follows_created, 0);
    } finally {
      inFlight.release();
    }
    const rows = (await db.query("SELECT account_id, profile_id FROM social_accounts ORDER BY profile_id")).rows;
    assert.deepEqual(rows, [
      { account_id: uuid(0xa1), profile_id: uuid(1) },
      { account_id: uuid(0xa2), profile_id: uuid(2) },
      { account_id: uuid(0xa3), profile_id: uuid(3) },
    ]);
    assert.deepEqual(await followPairs(db), ["3 -> 1 launch_code"]);

    // The recruit unfollows; a re-run does not re-add it.
    await db.query("DELETE FROM social_follows");
    assert.deepEqual((await backfill()).result, {
      profiles_scanned: 3,
      member_referrals_scanned: 1,
      ...ZERO_CHANGES,
      batches: 3,
    });
    assert.deepEqual(await followPairs(db), []);
  });
});
