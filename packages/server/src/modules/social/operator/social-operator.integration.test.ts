import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { Pool } from "pg";

import { createPool } from "@blast/core/modules/database/pool.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { SOCIAL_CONFIG_KEYS } from "@blast/core/modules/social/contracts/config.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { createSocialConfigReader, SOCIAL_CONFIG_CACHE_MS } from "@blast/core/modules/social/config/reader.ts";

/**
 * Social feed T-003: `npm run social:operator` as an operator runs it, as a
 * child process against a disposable database with T-001's schema, and the
 * cached readers routes and the worker use.
 */
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const run = promisify(execFile);
// The server package owns the operator CLI.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OPERATOR_ID = "ops.social-test";
const TOKEN = "social-operator-integration-token-32-chars";

const AUTHENTICATED = {
  MISSION_CONTROL_OPERATOR_ALLOWED_ID: OPERATOR_ID,
  MISSION_CONTROL_OPERATOR_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
  BLAST_OPERATOR_ID: OPERATOR_ID,
  BLAST_OPERATOR_TOKEN: TOKEN,
};

type CliResult = { code: number; stdout: string; stderr: string };

/** The CLI on the test's own database at `url`. */
async function cli(url: string, args: readonly string[], auth: Partial<typeof AUTHENTICATED> = AUTHENTICATED): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: url, ...auth };
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

function errorCode(result: CliResult): string | undefined {
  const line = result.stderr.split("\n").find((candidate) => candidate.startsWith('{"error"'));
  return line ? (JSON.parse(line) as { error: { code: string } }).error.code : undefined;
}

type Snapshot = { config: unknown[]; terms: unknown[]; log: unknown[] };

async function snapshot(db: Pool): Promise<Snapshot> {
  const [config, terms, log] = await Promise.all([
    db.query("SELECT key, value, updated_at, updated_by FROM social_config ORDER BY key"),
    db.query("SELECT term, added_at, added_by FROM social_blocked_terms ORDER BY term"),
    db.query("SELECT * FROM social_operator_log ORDER BY acted_at, log_id"),
  ]);
  return { config: config.rows, terms: terms.rows, log: log.rows };
}

async function logRows(db: Pool): Promise<{ operator_id: string; action: string; target: string; before: unknown; after: unknown; reason: string | null }[]> {
  return (await db.query("SELECT operator_id, action, target, before, after, reason FROM social_operator_log ORDER BY acted_at, log_id")).rows;
}

async function freshDatabase(): Promise<{ db: Pool; url: string; drop(): Promise<void> }> {
  const { url, drop } = await freshTestDatabase();
  return { db: createPool(url, { max: 4 }), url, drop };
}

test("T-003-AC-1 config set stores, logs before and after, and a warm reader sees it within 60 s", { skip }, async () => {
  const { db, url, drop } = await freshDatabase();
  try {
    let clock = 1_000_000;
    const reader = createSocialConfigReader(autocommitReader(db, "social"), { now: () => clock });
    assert.equal((await reader.getSocialConfig()).big_commit_usd, "1000", "initial value without a row");

    const set = await cli(url, ["config", "set", "big_commit_usd", "2500", "--reason", "raise the big-commit bar"]);
    assert.equal(set.code, 0, set.stderr);
    const printed = JSON.parse(set.stdout) as { command: string; logId: string; result: unknown };
    assert.equal(printed.command, "config set");
    assert.deepEqual(printed.result, { key: "big_commit_usd", before: "1000", after: "2500" });

    const stored = await db.query("SELECT value, updated_by FROM social_config WHERE key = 'big_commit_usd'");
    assert.deepEqual(stored.rows, [{ value: "2500", updated_by: OPERATOR_ID }]);
    assert.deepEqual(await logRows(db), [{
      operator_id: OPERATOR_ID,
      action: "config.set",
      target: "big_commit_usd",
      before: "1000",
      after: "2500",
      reason: "raise the big-commit bar",
    }]);
    const logIds = await db.query<{ log_id: string }>("SELECT log_id FROM social_operator_log");
    assert.equal(logIds.rows[0].log_id, printed.logId);

    // The warm cache still answers with the old value, then the new one once its 30 s pass.
    clock += 1_000;
    assert.equal((await reader.getSocialConfig()).big_commit_usd, "1000");
    clock += SOCIAL_CONFIG_CACHE_MS;
    assert.equal((await reader.getSocialConfig()).big_commit_usd, "2500");

    // A second set logs the stored value as `before`; lists are typed.
    const lists = await cli(url, ["config", "set", "reactions", "fire,rocket,gem"]);
    assert.equal(lists.code, 0, lists.stderr);
    const milestones = await cli(url, ["config", "set", "holder_milestones", "500,100,1000"]);
    assert.equal(milestones.code, 0, milestones.stderr);
    const again = await cli(url, ["config", "set", "big_commit_usd", "3000.50"]);
    assert.equal(again.code, 0, again.stderr);
    const log = await logRows(db);
    assert.equal(log.length, 4);
    assert.deepEqual(log[1], {
      operator_id: OPERATOR_ID, action: "config.set", target: "reactions",
      before: ["rocket"], after: ["fire", "rocket", "gem"], reason: null,
    });
    assert.deepEqual(log[2].after, [100, 500, 1000]);
    assert.deepEqual([log[3].before, log[3].after], ["2500", "3000.5"]);
    clock += SOCIAL_CONFIG_CACHE_MS;
    const config = await reader.getSocialConfig();
    assert.deepEqual(config.reactions, ["fire", "rocket", "gem"]);
    assert.deepEqual(config.holder_milestones, [100, 500, 1000]);
    assert.equal(config.big_commit_usd, "3000.5");
    assert.equal(config.why_boost_ms, 1_800_000);

    // `config get` reads what is stored and logs once.
    const get = await cli(url, ["config", "get", "big_commit_usd"]);
    assert.equal(get.code, 0, get.stderr);
    const value = (JSON.parse(get.stdout) as { result: { values: { key: string; value: unknown; source: string; updatedBy: string }[] } }).result.values;
    assert.deepEqual(value.map(({ key, value: v, source, updatedBy }) => ({ key, value: v, source, updatedBy })), [
      { key: "big_commit_usd", value: "3000.5", source: "stored", updatedBy: OPERATOR_ID },
    ]);
    const all = await cli(url, ["config", "get"]);
    assert.equal(all.code, 0, all.stderr);
    assert.equal((JSON.parse(all.stdout) as { result: { values: unknown[] } }).result.values.length, SOCIAL_CONFIG_KEYS.length);
    const afterGets = await logRows(db);
    assert.equal(afterGets.length, 6);
    assert.deepEqual(afterGets.slice(4).map((row) => [row.action, row.target]), [["config.get", "big_commit_usd"], ["config.get", "*"]]);
  } finally {
    await db.end();
    await drop();
  }
});

test("T-003-AC-1 refused config changes change nothing and log nothing", { skip }, async () => {
  const { db, url, drop } = await freshDatabase();
  try {
    assert.equal((await cli(url, ["config", "set", "big_commit_usd", "2500"])).code, 0);
    const before = await snapshot(db);
    for (const args of [
      ["config", "set", "nope", "1"],
      ["config", "set", "big_commit_usd", "abc"],
      ["config", "set", "big_commit_usd", "-1"],
      ["config", "set", "reactions", "fire,fire"],
      ["config", "set", "reactions", "a,b,c,d,e,f,g,h,i"],
      ["config", "set", "for_you_window_days", "1.5"],
      ["config", "set", "big_commit_usd"],
      ["config", "unset", "big_commit_usd"],
    ]) {
      const result = await cli(url, args);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.equal(errorCode(result), "OPERATOR_INPUT_INVALID", args.join(" "));
      assert.equal(result.stdout, "", args.join(" "));
    }
    assert.deepEqual(await snapshot(db), before);
  } finally {
    await db.end();
    await drop();
  }
});

test("T-003-AC-2 terms add and remove change what findBlockedTerm matches within 60 s; stored records are untouched", { skip }, async () => {
  const { db, url, drop } = await freshDatabase();
  try {
    await db.query(
      "INSERT INTO social_accounts (account_id, privy_did, callsign, display_name) VALUES ($1, $2, $3, $4)",
      ["00000000-0000-4000-8000-000000000301", "did:privy:moon-fan", "moonfan", "To the Moon"],
    );
    const account = await db.query("SELECT * FROM social_accounts");

    let clock = 5_000_000;
    const reader = createSocialConfigReader(autocommitReader(db, "social"), { now: () => clock });
    assert.equal(await reader.findBlockedTerm("to the MOON"), null);

    const add = await cli(url, ["terms", "add", "Moon", "--reason", "spam wave"]);
    assert.equal(add.code, 0, add.stderr);
    assert.deepEqual((JSON.parse(add.stdout) as { result: unknown }).result, { term: "moon", added: true });
    const stored = await db.query("SELECT term, added_by FROM social_blocked_terms");
    assert.deepEqual(stored.rows, [{ term: "moon", added_by: OPERATOR_ID }]);

    assert.equal(await reader.findBlockedTerm("to the MOON"), null, "the warm cache holds the old list");
    clock += SOCIAL_CONFIG_CACHE_MS;
    assert.equal(await reader.findBlockedTerm("to the MOON"), "moon");
    assert.equal(await reader.findBlockedTerm("to the sun"), null);

    // Adding again is a logged no-op.
    const repeat = await cli(url, ["terms", "add", "moon"]);
    assert.equal(repeat.code, 0, repeat.stderr);
    assert.deepEqual((JSON.parse(repeat.stdout) as { result: unknown }).result, { term: "moon", added: false });

    const list = await cli(url, ["terms", "list"]);
    assert.equal(list.code, 0, list.stderr);
    assert.deepEqual(
      (JSON.parse(list.stdout) as { result: { terms: { term: string }[] } }).result.terms.map((row) => row.term),
      ["moon"],
    );

    const remove = await cli(url, ["terms", "remove", "MOON"]);
    assert.equal(remove.code, 0, remove.stderr);
    assert.deepEqual((JSON.parse(remove.stdout) as { result: unknown }).result, { term: "moon", removed: true });
    assert.equal((await db.query("SELECT 1 FROM social_blocked_terms")).rowCount, 0);
    clock += SOCIAL_CONFIG_CACHE_MS;
    assert.equal(await reader.findBlockedTerm("to the MOON"), null);

    assert.deepEqual((await db.query("SELECT * FROM social_accounts")).rows, account.rows, "existing records are untouched");
    assert.deepEqual((await logRows(db)).map((row) => [row.action, row.target, row.before, row.after, row.reason]), [
      ["terms.add", "moon", { blocked: false }, { blocked: true }, "spam wave"],
      ["terms.add", "moon", { blocked: true }, { blocked: true }, null],
      ["terms.list", "*", null, null, null],
      ["terms.remove", "moon", { blocked: true }, { blocked: false }, null],
    ]);
  } finally {
    await db.end();
    await drop();
  }
});

test("T-003-AC-3 without valid operator authentication a command exits non-zero and writes nothing", { skip }, async () => {
  const { db, url, drop } = await freshDatabase();
  try {
    const before = await snapshot(db);
    const attempts: Partial<typeof AUTHENTICATED>[] = [
      {},
      { ...AUTHENTICATED, BLAST_OPERATOR_TOKEN: "wrong-token-that-is-at-least-32-characters" },
      { ...AUTHENTICATED, BLAST_OPERATOR_ID: "ops.someone-else" },
      { ...AUTHENTICATED, MISSION_CONTROL_OPERATOR_TOKEN_SHA256: "not-a-hash" },
      { BLAST_OPERATOR_ID: OPERATOR_ID, BLAST_OPERATOR_TOKEN: TOKEN },
    ];
    for (const auth of attempts) {
      for (const args of [["config", "set", "big_commit_usd", "2500"], ["terms", "add", "moon"], ["config", "get"]]) {
        const result = await cli(url, args, auth);
        assert.notEqual(result.code, 0);
        assert.equal(errorCode(result), "OPERATOR_AUTH_FAILED");
        assert.equal(result.stdout, "");
      }
    }
    assert.deepEqual(await snapshot(db), before);
    assert.equal((before.log as unknown[]).length, 0);
  } finally {
    await db.end();
    await drop();
  }
});
