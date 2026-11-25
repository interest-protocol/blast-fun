import assert from "node:assert/strict";
import test from "node:test";

import { socialHomeCoinsPath } from "@blast/core/modules/social/contracts/home.ts";
import { parseHolderLimit, readTopHolders, type FactsRow } from "@blast/server/modules/social/home/coins.ts";

test("holder reads default to ten, permit a bounded top 100 for one coin, and refuse invalid limits", () => {
  assert.equal(parseHolderLimit(new URLSearchParams(), 1), 10);
  assert.equal(
    parseHolderLimit(new URLSearchParams("holder_limit=100"), 1),
    100,
  );
  for (const value of ["0", "101", "1.5", "no", "100&holder_limit=10"]) {
    assert.throws(
      () => parseHolderLimit(new URLSearchParams(`holder_limit=${value}`), 1),
      { code: "invalid_parameter" },
    );
  }
  assert.throws(
    () => parseHolderLimit(new URLSearchParams("holder_limit=100"), 2),
    { code: "invalid_parameter" },
  );
  assert.equal(
    socialHomeCoinsPath(["sale"], "24h", 100),
    "/api/social/home/coins?presale=sale&holder_limit=100",
  );
  assert.equal(
    socialHomeCoinsPath(["sale"], "24h"),
    "/api/social/home/coins?presale=sale",
  );
});

test("the holder query keeps account grouping and deterministic balance order while bounding its result", async () => {
  const fact = {
    coin_type: "coin",
    presale_id: "sale",
    pool_id: "pool",
    launch_id: null,
    tracked_pool_only: false,
  } as FactsRow;
  const calls: unknown[][] = [];
  const db = {
    read: async <T extends object>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      assert.match(sql, /sum\(cb.balance\)/);
      assert.match(sql, /ORDER BY h.balance DESC, h.who/);
      calls.push([...params]);
      return {
        rows: [] as T[],
        command: "SELECT",
        rowCount: 0,
        oid: 0,
        fields: [],
      };
    },
  };
  await readTopHolders(db, [fact], 123);
  await readTopHolders(db, [fact], 123, 100);
  assert.deepEqual(calls, [
    [["coin"], ["sale", "pool"], 123, 10],
    [["coin"], ["sale", "pool"], 123, 100],
  ]);
});

test("a tracked pool coin skips the top-holders read and a launch coin still gets it", async () => {
  const launch = { coin_type: "launch", presale_id: null, pool_id: "launch-pool", launch_id: "curve", tracked_pool_only: false } as FactsRow;
  const tracked = { coin_type: "tracked", presale_id: null, pool_id: "tracked-pool", launch_id: null, tracked_pool_only: true } as FactsRow;
  const calls: unknown[][] = [];
  const db = {
    read: async <T extends object>(_sql: string, params: readonly unknown[] = []) => {
      calls.push([...params]);
      return { rows: [] as T[], command: "SELECT", rowCount: 0, oid: 0, fields: [] };
    },
  };
  assert.equal((await readTopHolders(db, [tracked], 123)).size, 0);
  await readTopHolders(db, [launch, tracked], 123);
  assert.deepEqual(calls, [[["launch"], ["launch-pool", "curve"], 123, 10]]);
});
