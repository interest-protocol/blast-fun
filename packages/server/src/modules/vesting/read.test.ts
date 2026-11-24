import assert from "node:assert/strict";
import test from "node:test";
import { ObjectError } from "@mysten/sui/client";
import type { QueryResult, QueryResultRow } from "pg";
import type { VestingState } from "@interest-protocol/blast-util-sdk/vesting";
import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import { createVestingReads } from "./read.ts";

const id = "0x" + "a".repeat(64);

function fixture(
  options: { indexed?: boolean; covered?: boolean; error?: Error } = {},
) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  let calls = 0;
  const reads = createVestingReads({
    database: () => ({
      async read<Row extends QueryResultRow>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        queries.push({ text, values });
        let rows: unknown[];
        if (text.includes("AS ready"))
          rows = [{ ready: options.covered ?? true }];
        else if (text.includes("utility_vesting_events"))
          rows = [{ event_id: "2:0:0" }];
        else
          rows = options.indexed
            ? [{ schedule_id: id, applied_checkpoint: "2", indexed: true }]
            : [];
        return {
          rows,
          rowCount: rows.length,
          command: "SELECT",
          oid: 0,
          fields: [],
        } as QueryResult<Row>;
      },
    }),
    client: {
      async getVesting() {
        calls++;
        if (options.error) throw options.error;
        return {
          kind: "linear",
          coinType: "0x2::sui::SUI",
          beneficiary: id,
          totalAmount: 100n,
          released: 0n,
          refundRecipient: null,
          schedule: { startMs: 0n, cliffMs: 0n, periodMs: 1n, periods: 100n },
        } as VestingState;
      },
    },
    metadata: async () => {
      throw new Error("Synthetic optional metadata failure");
    },
    now: () => 123,
  });
  return { reads, queries, calls: () => calls };
}

test("indexed vesting reads retain coverage and the exact committed event cut without provider access", async () => {
  const { reads, queries, calls } = fixture({ indexed: true });
  const detail = await reads.readVesting(id);
  assert.equal(detail.schedule.schedule_id, id);
  assert.equal(detail.now_ms, 123);
  assert.deepEqual(detail.events, [{ event_id: "2:0:0" }]);
  assert.equal(calls(), 0);
  assert.match(queries[0]!.text, /fault_checkpoint IS NULL/);
  assert.match(queries[0]!.text, /c.checkpoint >= s.applied_checkpoint/);
  assert.match(queries[2]!.text, /checkpoint <= \$2/);
  assert.deepEqual(queries[2]!.values, [id, "2"]);
});

test("public chain fallback preserves atom strings and optional metadata failure", async () => {
  const { reads, calls } = fixture();
  const detail = await reads.readVesting(id);
  assert.equal(calls(), 1);
  assert.equal(detail.schedule.indexed, false);
  assert.equal(detail.schedule.total, "100");
  assert.equal(detail.schedule.coin_symbol, null);
  assert.deepEqual(detail.events, []);
});

test("missing indexed coverage never converts an unobserved object into a permanent 404", async () => {
  for (const covered of [false, true]) {
    const { reads } = fixture({
      covered,
      error: new ObjectError("missing", "Synthetic missing", {
        reason: "notFound",
      }),
    });
    await assert.rejects(
      reads.readVesting(id),
      (error) =>
        error instanceof VestingReadError &&
        error.reason === (covered ? "not_found" : "unavailable"),
    );
  }
  const { reads, calls, queries } = fixture();
  await assert.rejects(
    reads.readVesting("invalid"),
    (error) =>
      error instanceof VestingReadError && error.reason === "not_found",
  );
  assert.equal(calls(), 0);
  assert.equal(queries.length, 0);
});

test("unsupported chain object remains a typed failure", async () => {
  const { reads } = fixture({
    error: new TypeError("Synthetic unsupported object"),
  });
  await assert.rejects(
    reads.readVesting(id),
    (error) =>
      error instanceof VestingReadError && error.reason === "unsupported",
  );
});
