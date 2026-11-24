import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, QueryResultRow } from "pg";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { CLAIM_STATEMENTS } from "../claims/settle.ts";
import { PORTFOLIO_SNAPSHOT_STATEMENTS } from "../portfolio/snapshots.ts";

const skip = !process.env.MISSION_CONTROL_TEST_DATABASE_URL;

async function rows<Row extends QueryResultRow>(db: Pool, sql: string, values: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, values)).rows;
}

test("claim recovery statements use the open-claim partial indexes", { skip }, async () => {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 1 });
  try {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL enable_seqscan = off");
    for (const [name, sql, values] of [
      ["settle", CLAIM_STATEMENTS.settleBatch, [1_000_000, 50]],
      ["expire", CLAIM_STATEMENTS.expire, [Date.now(), Date.now() - 86_400_000, Date.now()]],
      ["vesting", CLAIM_STATEMENTS.vestingPage, [null, null, 16]],
    ] as const) {
      const plan = (await rows<{ "QUERY PLAN": string }>(admin, `EXPLAIN ${sql}`, [...values])).map((row) => row["QUERY PLAN"]).join("\n");
      assert.match(plan, /social_transactions_open_claims_idx/, name);
    }
    // LP-12: sent launch claims page through 0136's own partial index.
    const launchPlan = (await rows<{ "QUERY PLAN": string }>(admin, `EXPLAIN ${CLAIM_STATEMENTS.launchPage}`, [null, null, 16])).map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(launchPlan, /social_transactions_open_launch_claims_idx/, "launch");
    await admin.query("ROLLBACK");
  } finally {
    await admin.end();
    await database.drop();
  }
});

test("snapshot retry, sweep and retention statements use their indexes", { skip }, async () => {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 1 });
  const owner = "00000000-0000-0000-0000-000000000000";
  try {
    await admin.query("BEGIN");
    await admin.query("SET LOCAL enable_seqscan = off");
    const plan = async (sql: string, values: unknown[]) =>
      (await rows<{ "QUERY PLAN": string }>(admin, `EXPLAIN ${sql}`, values)).map((row) => row["QUERY PLAN"]).join("\n");
    assert.match(await plan(PORTFOLIO_SNAPSHOT_STATEMENTS.retryPage, ["2026-10-04", "00000000-0000-0000-0000-000000000000", 100]), /social_portfolio_snapshots_skipped_idx/);
    const page = await plan(PORTFOLIO_SNAPSHOT_STATEMENTS.page, ["00000000-0000-0000-0000-000000000000", 100, "2026-10-06"]);
    assert.match(page, /social_accounts_pkey/);
    assert.match(page, /Index (Only )?Scan using social_portfolio_snapshots_pkey on social_portfolio_snapshots s[\s\S]*Index Cond: \(\(account_id = [ap]\.account_id\) AND \(day = '2026-10-06'::date\)\)/);
    assert.match(await plan(PORTFOLIO_SNAPSHOT_STATEMENTS.retention, [[owner], "2026-01-01"]), /social_portfolio_snapshots_pkey/);
    await admin.query("ROLLBACK");
  } finally {
    await admin.end();
    await database.drop();
  }
});
