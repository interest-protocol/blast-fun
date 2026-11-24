import assert from "node:assert/strict";
import test from "node:test";
import {
  createPool,
  createRuntimePool,
} from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import {
  CHAIN_READ_ROWS,
  seedChainRead,
  type ChainActivityRow,
} from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { readTradeCandles } from "@blast/server/modules/social/prices/trade-candles.ts";
import {
  CANDLE_INTERVALS,
  candleIntervalMs,
} from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { tradeCandlePageSchema } from "@blast/core/modules/social/contracts/trade-candles.ts";

const target = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
test(
  "pool candles aggregate individual committed fills exactly through replica views",
  { skip: target ? false : "disposable database required" },
  async () => {
    const database = await freshTestDatabase();
    const admin = createPool(database.url, { max: 1 });
    const replica = createRuntimePool(
      urlAs(database.url, "blast_replica"),
      {
        max: 1,
        connectionTimeoutMs: 5000,
        idleTimeoutMs: 1000,
        idleInTransactionMs: 5000,
        lockTimeoutMs: 2000,
        statementTimeoutMs: 8000,
      },
      "trade-candles-test",
    );
    const now = 1_800_000_000_000;
    const sale = {
      ...CHAIN_READ_ROWS.presales[0],
      sale_decimals: 9,
      quote_decimals: 6,
      quote_symbol: "USDC",
    };
    const tick = (
      index: number,
      offset: number,
      quote: string,
      overrides: Partial<ChainActivityRow> = {},
    ): ChainActivityRow => ({
      ...CHAIN_READ_ROWS.activity[0],
      checkpoint: index,
      timestamp_ms: now - 180_000 + offset,
      kind: "trade_buy",
      product: "market",
      quote_amount: quote,
      coin_amount: "1000000000",
      coin_type: sale.sale_token,
      quote_type: sale.quote_type,
      presale_id: sale.presale_id,
      tx_slot: index,
      event_slot: 4294967295,
      part: 0,
      digest: `tick${index}`,
      ...overrides,
    });
    try {
      await admin.query(
        `UPDATE watermarks SET checkpoint_hi_inclusive=CASE WHEN pipeline = 'market' THEN 200 ELSE 100 END, timestamp_ms_hi_inclusive=$1`,
        [now],
      );
      await seedChainRead(admin, {
        presales: [sale],
        presale_lifecycle: [
          {
            ...CHAIN_READ_ROWS.presale_lifecycle[2],
            timestamp_ms: now - 180_000,
          },
        ],
        // A wallet balance delta is deliberately unrelated to the individual fills.
        activity: [tick(1, 1000, "999000000000")],
      });
      const swaps = [
        tick(1, 1000, "1000000", { tx_slot: 1, event_slot: 0 }),
        tick(1, 1000, "3000000", { tx_slot: 1, event_slot: 1 }),
        tick(1, 1000, "2000000", { tx_slot: 1, event_slot: 2 }), // three fills in one routed/round-trip transaction
        tick(4, 120_000, "9007199254740993"),
        tick(6, 3000, "999000000", { quote_type: "different" }),
        tick(7, 3000, "999000000", { coin_amount: "0" }),
        tick(9, 3000, "999000000", { coin_amount: null }),
        tick(101, 3000, "999000000"), // ahead of the committed cut
        tick(8, 181_000, "999000000"), // future time
      ];
      for (const row of swaps) {
        await admin.query(
          `INSERT INTO blast_infra_fixture.presale_pool_swaps
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            sale.presale_id,
            sale.sale_token,
            row.quote_type,
            sale.pool_id,
            sale.venue,
            row.checkpoint,
            row.tx_slot,
            row.event_slot,
            row.timestamp_ms,
            row.coin_amount,
            row.quote_amount,
          ],
        );
      }
      await admin.query(`INSERT INTO blast_infra_fixture.checkpoint_headers
        SELECT checkpoint,'checkpoint-' || checkpoint,min(timestamp_ms)
        FROM blast_infra_fixture.presale_pool_swaps GROUP BY checkpoint`);
      // Same coin with an unrelated pool or sale must not bleed into this market.
      await admin.query(
        `INSERT INTO blast_infra_fixture.presale_pool_swaps
        VALUES ($1,$2,$3,'other-pool','cetus',10,1,0,$4,1,999999999),
               ('other-sale',$2,$3,$5,'cetus',11,1,0,$4,1,999999999)`,
        [
          sale.presale_id,
          sale.sale_token,
          sale.quote_type,
          now - 177000,
          sale.pool_id,
        ],
      );

      const db = autocommitReader(replica, "social");
      const request = {
        coin: sale.sale_token,
        presale: sale.presale_id,
        source: "pool_swaps",
        window: "launch",
        interval: "1m",
      } as const;
      const result = await readTradeCandles(db, request, now + 60_000);
      assert.equal(result.status, "available");
      assert.equal(
        result.candles.length,
        2,
        "empty middle minute has no invented candle",
      );
      assert.deepEqual(result.candles[0], {
        at_ms: now - 180_000,
        open: "1",
        high: "3",
        low: "1",
        close: "2",
        volume: "6",
        trades: 3,
      });
      assert.equal(
        result.candles[1]!.volume,
        "9007199254.740993",
        "no Number conversion above 2^53",
      );
      assert.equal(result.candles[1]!.close, "9007199254.740993");
      assert.equal(result.excluded_trades, 3);
      assert.ok(tradeCandlePageSchema.safeParse(result).success);
      for (const interval of CANDLE_INTERVALS) {
        const page = await readTradeCandles(db, { ...request, interval }, now);
        assert.equal(
          page.candles.reduce((total, candle) => total + candle.trades, 0),
          4,
          interval,
        );
        assert.ok(
          page.candles.every(
            (candle) => candle.at_ms % candleIntervalMs(interval) === 0,
          ),
        );
      }
      await admin.query(
        `UPDATE blast_infra_fixture.presales SET quote_decimals=18`,
      );
      const tiny = await readTradeCandles(db, request, now);
      assert.equal(
        tiny.candles[0]!.volume,
        "0.000000000006",
        "quote atom precision beyond 16 decimal places survives",
      );
      assert.equal(tiny.candles[0]!.open, "0.000000000001");
      await admin.query(`DELETE FROM blast_infra_fixture.presale_pool_swaps`);
      const empty = await readTradeCandles(db, request, now);
      assert.equal(empty.status, "available");
      assert.deepEqual(empty.candles, []);
      await admin.query(`DELETE FROM blast_infra_fixture.presales`);
      assert.equal(
        (await readTradeCandles(db, request, now)).status,
        "unsupported",
        "hidden/removed sales cannot leak trade rows",
      );
    } finally {
      await replica.end();
      await admin.end();
      await database.drop();
    }
  },
);
