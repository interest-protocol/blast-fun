import assert from "node:assert/strict";
import test from "node:test";

import { saleLifecycleAt } from "../contracts/presales.ts";

import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { namedOwnerSql, presalePostSql, visibleEntrySql } from "./naming.ts";
import {
  EntryQueryError,
  MAX_ENTRY_PAGE,
  entryFromRow,
  entryIdBranch,
  isVisible,
  personEntriesOf,
  presalePostEntriesOf,
} from "./entries.ts";
import { presalePhase, saleIsLive } from "./chain-presales.ts";

/**
 * Social feed T-004 unit checks: the SQL fragments' shape and guards, entry id
 * routing, window and threshold validation and row mapping. The rule's
 * behaviour on data is proven by read-model.integration.test.ts.
 */
const PRESALE = `0x${"ab".repeat(32)}`;
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const THRESHOLDS = { bigCommitUsd: "250", bigTradeUsd: "1000.5" };

function recorder(rows: QueryResultRow[] = []): ReadableDatabase & { calls: { text: string; values: readonly unknown[] }[] } {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  return {
    calls,
    read: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
      calls.push({ text, values });
      return { rows } as unknown as QueryResult<Row>;
    },
  };
}

test("namedOwnerSql states every clause of the naming rule against the entry alias", () => {
  const sql = namedOwnerSql("feed");
  for (const clause of [
    "named_owner.address = feed.actor",
    "named_account.privacy = 'public'",
    "named_account.sharing_since IS NOT NULL",
    "extract(epoch FROM named_account.sharing_since) * 1000 <= feed.occurred_at_ms",
    "extract(epoch FROM named_owner.linked_at) * 1000 <= feed.occurred_at_ms",
  ]) {
    assert.ok(sql.includes(clause), clause);
  }
  assert.ok(!sql.includes(";"));
});

test("fragments refuse anything but an alias and a numbered parameter", () => {
  assert.throws(() => namedOwnerSql("e; DROP TABLE x"), /Not a SQL alias/);
  assert.throws(() => namedOwnerSql("E"), /Not a SQL alias/);
  assert.throws(() => presalePostSql("e", "250", "$2"), /Not a SQL parameter/);
  assert.throws(() => visibleEntrySql("e", "$1", "$0"), /Not a SQL parameter/);
  assert.match(presalePostSql("e", "$7", "$8"), /e\.usd_value >= \$7::numeric[\s\S]*e\.usd_value >= \$8::numeric/);
});

test("entry ids route to their branch of the union", () => {
  assert.deepEqual(entryIdBranch("a:1000:0:0:1"), { source: "activity", activityId: "1000:0:0:1" });
  assert.deepEqual(entryIdBranch(`l:${PRESALE}:created`), { source: "lifecycle", presaleId: PRESALE });
  assert.deepEqual(entryIdBranch(`l:${PRESALE}:funded`), { source: "lifecycle", presaleId: PRESALE });
  assert.deepEqual(entryIdBranch(`m:${PRESALE}:raise:100.5`), { source: "milestone", presaleId: PRESALE });
  for (const bad of [
    "", "a:", "a:1:2:3", "a:01:0:0:0", "a:1:0:0:0:0", `l:${PRESALE}:closed`, `l:${PRESALE}`, `l:0xAB:funded`,
    `m:${PRESALE}:raise`, "x:1", `a:${"1".repeat(600)}:0:0:0`,
  ]) {
    assert.equal(entryIdBranch(bad), null, bad);
  }
});

test("isVisible answers false for an id no branch holds without reading", async () => {
  const db = recorder();
  assert.equal(await isVisible(db, "bogus", THRESHOLDS), false);
  assert.equal(db.calls.length, 0);
});

test("isVisible filters one branch by literal source and its key", async () => {
  const db = recorder([{ visible: true }]);
  assert.equal(await isVisible(db, `l:${PRESALE}:opened`, THRESHOLDS), true);
  assert.match(db.calls[0].text, /e\.source = 'lifecycle' AND e\.presale_id = \$3 AND e\.entry_id = \$4/);
  assert.deepEqual(db.calls[0].values, ["250", "1000.5", PRESALE, `l:${PRESALE}:opened`]);
  await isVisible(db, "a:7:1:2:3", THRESHOLDS);
  assert.match(db.calls[1].text, /e\.source = 'activity' AND e\.activity_id = \$3/);
  assert.equal(db.calls[1].values[2], "7:1:2:3");
});

test("windows, ids and thresholds are validated before any read", async () => {
  const db = recorder();
  for (const limit of [0, MAX_ENTRY_PAGE + 1, 1.5]) {
    await assert.rejects(personEntriesOf(db, [ACCOUNT], { limit }), EntryQueryError);
  }
  await assert.rejects(personEntriesOf(db, [ACCOUNT], { limit: 1, sinceMs: -1 }), EntryQueryError);
  await assert.rejects(personEntriesOf(db, [ACCOUNT], { limit: 1, before: { occurredAtMs: 1, entryId: "" } }), EntryQueryError);
  await assert.rejects(personEntriesOf(db, ["not-a-uuid"], { limit: 1 }), EntryQueryError);
  await assert.rejects(presalePostEntriesOf(db, ["0x1"], THRESHOLDS, { limit: 1 }), EntryQueryError);
  await assert.rejects(presalePostEntriesOf(db, "all", { bigCommitUsd: "-1", bigTradeUsd: "1" }, { limit: 1 }), EntryQueryError);
  await assert.rejects(isVisible(db, "a:1:0:0:0", { bigCommitUsd: "1e3", bigTradeUsd: "1" }), EntryQueryError);
  assert.deepEqual(await personEntriesOf(db, [], { limit: 1 }), []);
  assert.deepEqual(await presalePostEntriesOf(db, [], THRESHOLDS, { limit: 1 }), []);
  assert.equal(db.calls.length, 0);
});

test("selections order newest first then by entry id bytewise, and number the window's parameters", async () => {
  const db = recorder();
  await personEntriesOf(db, [ACCOUNT, ACCOUNT], { limit: 5, before: { occurredAtMs: 9, entryId: "a:9:0:0:0" }, sinceMs: 3 });
  const [{ text, values }] = db.calls;
  assert.deepEqual(values, [[ACCOUNT], 9, "a:9:0:0:0", 3, 5]);
  assert.match(text, /\(e\.occurred_at_ms, e\.entry_id COLLATE "C"\) < \(\$2::bigint, \$3::text COLLATE "C"\)/);
  assert.match(text, /e\.occurred_at_ms >= \$4::bigint/);
  assert.match(text, /ORDER BY e\.occurred_at_ms DESC, e\.entry_id COLLATE "C" DESC LIMIT \$5$/);
  assert.match(text, /e\.actor IN \(SELECT o\.address FROM social_wallet_owners o WHERE o\.account_id = ANY\(\$1::uuid\[\]\)\)/);
  assert.ok(!text.includes(";"));

  await presalePostEntriesOf(db, [PRESALE], THRESHOLDS, { limit: 2 });
  assert.deepEqual(db.calls[1].values, ["250", "1000.5", [PRESALE], 2]);
  assert.match(db.calls[1].text, /e\.presale_id = ANY\(\$3::text\[\]\)/);
  await presalePostEntriesOf(db, "all", THRESHOLDS, { limit: 2 });
  assert.deepEqual(db.calls[2].values, ["250", "1000.5", 2]);
});

test("rows map to entries with millisecond numbers and decimal strings", () => {
  assert.deepEqual(
    entryFromRow({
      entry_id: "a:1:0:0:0", source: "activity", kind: "future_kind", product: "market", occurred_at_ms: "1790000000000",
      actor: PRESALE, presale_id: null, coin_type: null, digest: "D", activity_id: "1:0:0:0", quote_type: "q",
      quote_amount: "1", coin_amount: null, quote_refund: null, usd_value: "12.50", usd_price_as_of_ms: "1789999999000",
      milestone_value: null, named_account_id: null,
    }),
    {
      entryId: "a:1:0:0:0", source: "activity", kind: "future_kind", product: "market", occurredAtMs: 1_790_000_000_000,
      actor: PRESALE, presaleId: null, coinType: null, digest: "D", activityId: "1:0:0:0", quoteType: "q",
      quoteAmount: "1", coinAmount: null, quoteRefund: null, usdValue: "12.50", usdPriceAsOfMs: 1_789_999_999_000,
      milestoneValue: null, namedAccountId: null,
    },
  );
});

test("#588/#774: an open sale before its scheduled start reads pending; from the start it is open", () => {
  const now = 1_800_000_000_000;
  assert.equal(saleLifecycleAt("open", now + 1, now), "pending");
  assert.equal(saleLifecycleAt("open", now, now), "open");
  assert.equal(saleLifecycleAt("open", now - 1, now), "open");
  assert.equal(saleLifecycleAt("open", undefined, now), "open", "without a start the chain's lifecycle stands");
  for (const lifecycle of ["pending", "funded", "migrated", "cancelled"]) {
    assert.equal(saleLifecycleAt(lifecycle, now + 1, now), lifecycle);
  }
});

test("#774: a sale is live from its start until its end, and only while open", () => {
  const sale = (lifecycle: string) => ({ lifecycle, start_ms: 10, end_ms: 20 });
  assert.equal(saleIsLive(sale("open"), 9), false, "before the start");
  assert.equal(saleIsLive(sale("open"), 10), true, "at the start");
  assert.equal(saleIsLive(sale("open"), 19), true);
  assert.equal(saleIsLive(sale("open"), 20), false, "at the end");
  for (const lifecycle of ["pending", "funded", "migrated", "cancelled"]) {
    assert.equal(saleIsLive(sale(lifecycle), 15), false, lifecycle);
  }
});

test("#774: a presale's phase reads pending before its start, open until its end, then closed", () => {
  assert.equal(presalePhase("pending", 0, 10, 5), "pending");
  assert.equal(presalePhase("open", 8, 10, 7), "pending");
  assert.equal(presalePhase("open", 8, 10, 8), "open");
  assert.equal(presalePhase("open", 0, 10, 10), "closed");
  assert.equal(presalePhase("funded", 0, 10, 5), "funded");
  assert.equal(presalePhase("migrated", 0, 10, 5), "trading");
  assert.equal(presalePhase("cancelled", 0, 10, 5), "cancelled");
  assert.equal(presalePhase("something_new", 0, 10, 5), "closed");
});
