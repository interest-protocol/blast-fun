import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_CONFIG_DEFAULTS } from "@blast/core/modules/social/contracts/config.ts";
import { readHappening } from "@blast/server/modules/social/happening/read.ts";
import { deferred } from "../../../../../core/test/kit.ts";

function fixture() {
  const top = deferred();
  const calls: string[] = [];
  let dependentFailure: Error | undefined;
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
      calls.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("FROM chain_read_v1.watermark")) {
        rows = [{ market_checkpoint: "10", market_timestamp_ms: "1000", presale_checkpoint: "11", presale_timestamp_ms: "1000", observed_ms: "1000" }];
      } else if (sql.startsWith("SELECT market.*")) {
        await top.promise;
      } else if (sql.startsWith("SELECT * FROM ((SELECT")) {
        rows = [{ presale_id: "sale", role: "open", launched_ms: null, sort_ms: "2000" }];
      } else if (sql.startsWith("SELECT a.presale_id, sum") && dependentFailure) {
        throw dependentFailure;
      }
      return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<Row>;
    },
  };
  return { db, top, calls, fail(error: Error) { dependentFailure = error; } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("sale enrichment starts while the optional Top coins query is still running", async () => {
  const source = fixture();
  let settled = false;
  const response = readHappening(source.db, { config: SOCIAL_CONFIG_DEFAULTS, nowMs: 1000, hiddenKinds: [] });
  void response.then(() => { settled = true; });
  await tick();
  assert.ok(source.calls.some((sql) => !sql.startsWith("SELECT market.*") && sql.includes("coalesce(p.sale_symbol,'') AS symbol")), "chips start without waiting for Top coins");
  assert.ok(source.calls.some((sql) => sql.startsWith("SELECT a.presale_id, sum")), "velocity starts without waiting for Top coins");
  assert.ok(source.calls.some((sql) => sql.startsWith("SELECT f.target_id")), "followers start without waiting for Top coins");
  assert.equal(settled, false, "response still owns the outstanding Top coins work");
  source.top.resolve();
  assert.deepEqual((await response).top_coins, { trending: [], gainers: [] });
  assert.equal(source.calls.length, 10, "pipelining adds no source reads");
});

test("a failed dependent read retains ownership until the independent Top coins query settles", async () => {
  const source = fixture();
  const error = new Error("velocity unavailable");
  source.fail(error);
  let settled = false;
  const response = readHappening(source.db, { config: SOCIAL_CONFIG_DEFAULTS, nowMs: 1000, hiddenKinds: [] });
  void response.then(() => { settled = true; }, () => { settled = true; });
  await tick();
  assert.ok(source.calls.some((sql) => sql.startsWith("SELECT a.presale_id, sum")));
  assert.equal(settled, false);
  source.top.resolve();
  await assert.rejects(response, (actual: unknown) => actual === error);
});
