import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { readLaunchVerifiedTeam, verifiedTeamSql } from "@blast/server/modules/social/read-model/verified-team.ts";
import { createAdminVerifiedMarkRoute } from "@blast/server/modules/social/admin-verified/route.ts";

/**
 * R3-23: a bonding-curve coin's "Team verified by Blast" flag. The admin
 * website's route sets and clears it on the web role, as the backend runs it;
 * the operator CLI (a child process, the owning login) only lists and reads
 * history; the reads run on the web role, as the coin page and the coin lists do.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const OPERATOR_ID = "ops.coin-trust-test";
const TOKEN = "social-coin-trust-integration-token-32";
const AUTHENTICATED = {
  MISSION_CONTROL_OPERATOR_ALLOWED_ID: OPERATOR_ID,
  MISSION_CONTROL_OPERATOR_TOKEN_SHA256: createHash("sha256").update(TOKEN).digest("hex"),
  BLAST_OPERATOR_ID: OPERATOR_ID,
  BLAST_OPERATOR_TOKEN: TOKEN,
};
const LAUNCH = `0x${"ab".repeat(32)}`;
const COIN = `0x${"cd".repeat(32)}::meme::MEME`;
const OTHER = `0x${"ef".repeat(32)}::meme::MEME`;
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 2, statementTimeoutMs: 10_000 };

type CliResult = { code: number; stdout: string; stderr: string };

async function cli(url: string, args: readonly string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test", PATH: process.env.PATH, DATABASE_URL: url, ...AUTHENTICATED };
  try {
    const { stdout, stderr } = await run(process.execPath, ["--no-warnings", "--experimental-strip-types", "scripts/social-operator.ts", ...args], { cwd: ROOT, env });
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

type Answer = { status: number; body: Record<string, unknown> };

test("R3-23 coin trust: the admin route marks a Blast curve coin for the coin page and the coin reads, clears it, both logged; the CLI cannot", { skip }, async () => {
  const { url } = await freshTestDatabase();
  const admin = createPool(url, { max: 2 });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "coin-trust-web");
  try {
    await admin.query(`INSERT INTO coins (coin_type, decimals, launcher, creator, metadata, pool_key, created_checkpoint, created_at_ms)
      VALUES ($1, 9, '0xc0ffee', '0xc0ffee', '{"name":"Meme","symbol":"MEME","description":"","icon_url":""}', $2, 900, 1790000000000)`, [COIN, `blast_curve:${LAUNCH}`]);
    await admin.query(`INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
      VALUES ($1, 'blast_curve', $2, '0x2::sui::SUI', 'live', 900, 1790000000000)`, [`blast_curve:${LAUNCH}`, COIN]);
    const reader = autocommitReader(web, "social", { label: "test.coin_trust" });
    const route = createAdminVerifiedMarkRoute(() => web);
    const mark = async (body: unknown): Promise<Answer> => {
      const response = await route(new Request("https://backend.test/api/admin/verified-mark", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const marked = async (coinType: string) =>
      (await web.query<{ verified: boolean }>(`SELECT ${verifiedTeamSql("NULL::text", "$1::text")} AS verified`, [coinType])).rows[0]?.verified;

    assert.equal(await readLaunchVerifiedTeam(LAUNCH, reader), false);
    assert.equal(await marked(COIN), false);

    // Jose 2026-11-21: the CLI no longer writes the mark.
    for (const args of [["coin", "trust", "set", COIN, "--reason", "x"], ["coin", "trust", "clear", COIN, "--reason", "x"]]) {
      assert.equal(errorCode(await cli(url, args)), "OPERATOR_INPUT_INVALID", args.join(" "));
    }
    for (const reason of [undefined, "", "   ", "x".repeat(501), "line\nbreak"]) {
      assert.equal((await mark({ kind: "coin", target: COIN, verified: true, reason })).status, 400, String(reason));
    }
    assert.deepEqual(await mark({ kind: "coin", target: OTHER, verified: true, reason: "not ours" }), {
      status: 404, body: { error: { code: "not_found", message: "That is not a Blast bonding-curve coin. For a presale's coin, mark the presale." } },
    });
    assert.equal((await admin.query("SELECT 1 FROM social_operator_log")).rowCount, 0, "a refused change logs nothing");

    const set = await mark({ kind: "coin", target: COIN.replace(/^0x[0-9a-f]+/, (address) => `0x${address.slice(2).toUpperCase()}`), verified: true, reason: "  Jose: video call with the team (OPS-9) " });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.deepEqual({ ...set.body, log_id: null }, { kind: "coin", target: COIN, verified: true, changed: true, log_id: null });
    assert.equal(await readLaunchVerifiedTeam(LAUNCH, reader), true);
    assert.equal(await marked(COIN), true);
    assert.equal(await marked(OTHER), false);
    const listed = JSON.parse((await cli(url, ["coin", "trust", "list"])).stdout) as { result: { coins: { coin_type: string; verified_by: string }[] } };
    assert.deepEqual(listed.result.coins.map((row) => [row.coin_type, row.verified_by]), [[COIN, "admin-console"]]);
    const panel = await (await route(new Request("https://backend.test/api/admin/verified-mark"))).json() as { coins: unknown[]; presales: unknown[]; truncated: boolean };
    assert.deepEqual(panel.coins.map((row) => ({ ...(row as object), verified_at_ms: null })), [
      { target: COIN, name: "Meme", symbol: "MEME", verified_by: "admin-console", verified_at_ms: null, note: "Jose: video call with the team (OPS-9)" },
    ]);
    assert.deepEqual([panel.presales, panel.truncated], [[], false]);
    assert.equal((await mark({ kind: "coin", target: COIN, verified: true, reason: "again" })).body.changed, false, "a repeat is a logged no-op");

    const clear = await mark({ kind: "coin", target: COIN, verified: false, reason: "Team changed" });
    assert.equal(clear.status, 200, JSON.stringify(clear.body));
    assert.equal(clear.body.changed, true);
    assert.equal(await readLaunchVerifiedTeam(LAUNCH, reader), false);
    const { rows } = await admin.query<{ operator_id: string; action: string; before: unknown; after: unknown; reason: string }>(
      "SELECT operator_id, action, before, after, reason FROM social_operator_log WHERE target = $1 ORDER BY acted_at, log_id", [COIN]);
    const flag = (verified_team: boolean) => ({ verified_team });
    assert.deepEqual(rows, [
      { operator_id: "admin-console", action: "coin.trust.set", before: flag(false), after: flag(true), reason: "Jose: video call with the team (OPS-9)" },
      { operator_id: "admin-console", action: "coin.trust.set", before: flag(true), after: flag(true), reason: "again" },
      { operator_id: "admin-console", action: "coin.trust.clear", before: flag(true), after: flag(false), reason: "Team changed" },
    ]);
    const history = JSON.parse((await cli(url, ["coin", "trust", "history", COIN])).stdout) as { result: { changes: unknown[] } };
    assert.equal(history.result.changes.length, 3);
    const panelHistory = await (await route(new Request(`https://backend.test/api/admin/verified-mark?kind=coin&target=${encodeURIComponent(COIN)}`))).json() as { changes: { action: string }[] };
    assert.deepEqual(panelHistory.changes.map((change) => change.action), ["coin.trust.clear", "coin.trust.set", "coin.trust.set"]);
    // 0165: the web role appends log rows; it never rewrites or deletes one.
    await assert.rejects(web.query("DELETE FROM social_operator_log"), /permission denied/);
    await assert.rejects(web.query("UPDATE social_operator_log SET reason = 'rewritten'"), /permission denied/);
  } finally {
    await web.end();
    await admin.end();
  }
});
