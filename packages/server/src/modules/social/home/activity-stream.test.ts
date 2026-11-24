import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import {
  parseActivityStreamQuery,
  readHomeActivityStream,
} from "./activity-stream.ts";

test("public Activity validates its window, page size and selectors once", () => {
  assert.deepEqual(parseActivityStreamQuery(new URLSearchParams()), {
    window: "24h",
    limit: 20,
    cursor: null,
  });
  assert.deepEqual(
    parseActivityStreamQuery(new URLSearchParams("window=1h&limit=50")),
    { window: "1h", limit: 50, cursor: null },
  );
  for (const query of [
    "window=7d",
    "window=1h&window=24h",
    "limit=0",
    "limit=51",
    "limit=1.5",
    "limit=NaN",
    "limit=",
    "limit=01",
    "limit=1&limit=2",
    "cursor=",
    "actor=maya",
    "account=mine",
    "follow=all",
  ]) {
    assert.throws(
      () => parseActivityStreamQuery(new URLSearchParams(query)),
      { code: "invalid_parameter" },
      query,
    );
  }
});

test("Activity emits a traversable cursor from one watermark observation while the index advances", async () => {
  let observations = 0;
  const row = {
    activity_id: "99:0:0:0",
    kind: "trade_buy",
    timestamp_ms: "900",
    checkpoint: "99",
    tx_slot: 0,
    event_slot: 0,
    part: 0,
    digest: "digest",
    quote_type: "0x2::sui::SUI",
    sale_quote: "0x2::sui::SUI",
    sale_quote_symbol: "SUI",
    sale_quote_decimals: 9,
    quote_amount: "1",
    coin_amount: "2",
    quote_refund: null,
    usd_value: null,
    has_why: false,
    actor: "0x" + "1".repeat(64),
    account_id: null,
    callsign: null,
    display_name: null,
    avatar_url: null,
    x_handle: null,
    verified: false,
    sale_coin: "0xc::coin::SOLO",
    presale_id: null,
    lifecycle: "migrated",
    sale_decimals: 9,
    sale_symbol: "SOLO",
    sale_name: "Solo",
    sale_icon_url: null,
  };
  const db = {
    async read<Row extends QueryResultRow>(sql: string) {
      if (sql.includes("FROM chain_read_v1.watermark")) {
        const advanced = observations++ > 0;
        return {
          command: "SELECT",
          rowCount: 1,
          oid: 0,
          fields: [],
          rows: [
            {
              market_checkpoint: advanced ? "150" : "100",
              market_timestamp_ms: advanced ? "2000" : "1000",
              presale_checkpoint: advanced ? "150" : "100",
              presale_timestamp_ms: advanced ? "2000" : "1000",
              observed_ms: advanced ? "3001" : "3000",
            } as unknown as Row,
          ],
        };
      }
      return {
        command: "SELECT",
        rowCount: 2,
        oid: 0,
        fields: [],
        rows: [
          row,
          { ...row, activity_id: "98:0:0:0", checkpoint: "98" },
        ] as unknown as Row[],
      };
    },
  };
  const first = await readHomeActivityStream(
    db,
    { window: "24h", limit: 1, cursor: null },
    { nowMs: 3000, hiddenKinds: [] },
  );
  assert.equal(first.clock_ms, 1000);
  assert.deepEqual(first.as_of, {
    checkpoint: 100,
    timestamp_ms: 1000,
    lag_ms: 2000,
  });
  assert.ok(first.next_cursor);
  const next = await readHomeActivityStream(
    db,
    { window: "24h", limit: 1, cursor: first.next_cursor },
    { nowMs: 3001, hiddenKinds: [] },
  );
  assert.equal(next.clock_ms, 1000);
  assert.deepEqual(next.as_of, {
    checkpoint: 100,
    timestamp_ms: 1000,
    lag_ms: 2001,
  });
});
