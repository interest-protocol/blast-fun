import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import type { Pool } from "pg";

import { createPool } from "@blast/core/modules/database/pool.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { uuid } from "../../../../../../packages/core/test/kit.ts";

/**
 * Social feed T-013 (AC-031): `npm run social:operator -- defaults set` as an
 * operator runs it, as a child process against a disposable database.
 */
const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const run = promisify(execFile);
// Run the operator from its owning server package.
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OPERATOR_ID = "ops.social-defaults-test";
const TOKEN = "social-defaults-integration-token-32-chars";
const ENV = {
  MISSION_CONTROL_OPERATOR_ALLOWED_ID: OPERATOR_ID,
  MISSION_CONTROL_OPERATOR_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
  BLAST_OPERATOR_ID: OPERATOR_ID,
  BLAST_OPERATOR_TOKEN: TOKEN,
};

type CliResult = { code: number; stdout: string; stderr: string };

/** The CLI on the test's own database at `url`. */
async function cli(url: string, args: readonly string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: url, ...ENV };
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

/** Five new accounts, one more, and a Mission Control member with no social row yet. */
const CALLSIGNS = ["alpha_one", "bravo_two", "charlie_3", "delta_four", "echo_five", "fox_six"];
const MEMBER_CALLSIGN = "member_pilot";
const MEMBER_PROFILE = uuid(0x77);

async function freshDatabase(): Promise<{ db: Pool; url: string; drop(): Promise<void> }> {
  const { url, drop } = await freshTestDatabase();
  const db = createPool(url, { max: 4 });
  for (const [index, callsign] of CALLSIGNS.entries()) {
    await db.query("INSERT INTO social_accounts (account_id, privy_did, callsign) VALUES ($1, $2, $3)", [
      uuid(0x100 + index),
      `did:privy:defaults-${index}`,
      callsign,
    ]);
  }
  await db.query(
    `INSERT INTO mission_control_profiles (
       profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, disclosure_version, disclosure_accepted_at
     ) VALUES ($1, 'did:privy:defaults-member', 'x-defaults-member', $2, 'wallet-member', $3, 'fixture-v1', now())`,
    [MEMBER_PROFILE, `0x${"7".repeat(64)}`, MEMBER_CALLSIGN],
  );
  return { db, url, drop };
}

type Snapshot = { defaults: unknown[]; accounts: unknown[]; log: unknown[] };

async function snapshot(db: Pool): Promise<Snapshot> {
  const [defaults, accounts, log] = await Promise.all([
    db.query("SELECT position, account_id FROM social_default_accounts ORDER BY position"),
    db.query("SELECT account_id, profile_id, callsign FROM social_accounts ORDER BY account_id"),
    db.query("SELECT * FROM social_operator_log ORDER BY acted_at, log_id"),
  ]);
  return { defaults: defaults.rows, accounts: accounts.rows, log: log.rows };
}

async function configuredCallsigns(db: Pool): Promise<string[]> {
  return (await db.query<{ callsign: string }>(
    `SELECT i.callsign FROM social_default_accounts d
     JOIN social_account_identities i ON i.account_id = d.account_id ORDER BY d.position`,
  )).rows.map((row) => row.callsign);
}

test("T-013-AC-4 (AC-031): defaults set refuses a wrong count, a duplicate or an unknown callsign and changes nothing", { skip }, async () => {
  const { db, url, drop } = await freshDatabase();
  try {
    const before = await snapshot(db);
    const refused: [string[], string][] = [
      [CALLSIGNS.slice(0, 4), "OPERATOR_INPUT_INVALID"],
      [CALLSIGNS, "OPERATOR_INPUT_INVALID"],
      [[...CALLSIGNS.slice(0, 4), CALLSIGNS[0]!], "OPERATOR_INPUT_INVALID"],
      [[...CALLSIGNS.slice(0, 2), "ALPHA_ONE", "delta_four", "echo_five"], "OPERATOR_INPUT_INVALID"],
      [[...CALLSIGNS.slice(0, 4), "Not A Callsign"], "OPERATOR_INPUT_INVALID"],
      // The member's row would be created, but the unknown callsign refuses the whole command.
      [[MEMBER_CALLSIGN, ...CALLSIGNS.slice(0, 3), "ghost_pilot"], "OPERATOR_TARGET_NOT_FOUND"],
    ];
    for (const [callsigns, code] of refused) {
      const result = await cli(url, ["defaults", "set", ...callsigns]);
      assert.equal(result.code, 1, callsigns.join(" "));
      assert.equal(errorCode(result), code, callsigns.join(" "));
      assert.equal(result.stdout, "");
      assert.deepEqual(await snapshot(db), before, callsigns.join(" "));
    }
  } finally {
    await db.end();
    await drop();
  }
});

test("T-013-AC-4 (AC-031): five valid callsigns are stored in order and logged; a member gets its account row", { skip }, async () => {
  const { db, url, drop } = await freshDatabase();
  try {
    const first = [MEMBER_CALLSIGN, "echo_five", "@Bravo_Two", "alpha_one", "delta_four"];
    const set = await cli(url, ["defaults", "set", ...first, "--reason", "launch lineup"]);
    assert.equal(set.code, 0, set.stderr);
    const stored = [MEMBER_CALLSIGN, "echo_five", "bravo_two", "alpha_one", "delta_four"];
    const printed = JSON.parse(set.stdout) as { command: string; logId: string; result: unknown };
    assert.equal(printed.command, "defaults set");
    assert.deepEqual(printed.result, { before: [], after: stored });
    assert.deepEqual(await configuredCallsigns(db), stored);
    const member = await db.query("SELECT callsign, onboarded_at FROM social_accounts WHERE profile_id = $1", [MEMBER_PROFILE]);
    assert.deepEqual(member.rows, [{ callsign: null, onboarded_at: null }], "a member's row is created as resolution would");
    const positions = await db.query<{ position: number }>("SELECT position FROM social_default_accounts ORDER BY position");
    assert.deepEqual(positions.rows.map((row) => row.position), [1, 2, 3, 4, 5]);

    // Replacing the set logs the previous lineup as `before`.
    const second = ["fox_six", "alpha_one", "bravo_two", "charlie_3", "echo_five"];
    const again = await cli(url, ["defaults", "set", ...second]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(await configuredCallsigns(db), second);
    const log = await db.query("SELECT operator_id, action, target, before, after, reason FROM social_operator_log ORDER BY acted_at, log_id");
    assert.deepEqual(log.rows, [
      { operator_id: OPERATOR_ID, action: "defaults.set", target: "*", before: [], after: stored, reason: "launch lineup" },
      { operator_id: OPERATOR_ID, action: "defaults.set", target: "*", before: stored, after: second, reason: null },
    ]);
    assert.equal((await db.query<{ log_id: string }>("SELECT log_id FROM social_operator_log ORDER BY acted_at LIMIT 1")).rows[0]!.log_id, printed.logId);
  } finally {
    await db.end();
    await drop();
  }
});
