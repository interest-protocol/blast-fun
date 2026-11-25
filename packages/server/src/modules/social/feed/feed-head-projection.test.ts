import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { forYouEntries, forYouNewHead } from "@blast/server/modules/social/feed/for-you.ts";

test("chronological heads omit entry hydration and rank lookups while ranked pages retain them", async () => {
  const queries: string[] = [];
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
      queries.push(sql);
      return { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] } as QueryResult<Row>;
    },
  };
  await forYouNewHead(db, { config: SOCIAL_CONFIG_DEFAULTS, nowMs: 1000, max: 50, hiddenKinds: [] });
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /SELECT e.entry_id, e.occurred_at_ms, named.account_id AS named_account_id/);
  assert.doesNotMatch(queries[0]!, /social_whys|AS rank_ms|e\.digest|e\.quote_amount/);
  queries.length = 0;
  await forYouEntries(db, { config: SOCIAL_CONFIG_DEFAULTS, nowMs: 1000, limit: 10, hiddenKinds: [] });
  const scan = queries.find((sql) => sql.includes("LIMIT $8"));
  assert.ok(scan);
  assert.match(scan, /social_whys/);
  assert.match(scan, /AS rank_ms/);
  assert.match(scan, /SELECT e\.\*, chosen\.named_account_id, chosen\.rank_ms/);
});
