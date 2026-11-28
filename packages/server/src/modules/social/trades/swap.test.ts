import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { QueryResult, QueryResultRow } from "pg";

import { CORE_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { COIN_METADATA_SQL } from "@blast/server/modules/social/portfolio/coin-metadata.ts";
import { readTradeCoins } from "@blast/server/modules/social/trades/coins.ts";
import { SALE_B, SUI } from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { filledOut, fullnodeTradeLookup, tradeBody, tradeLogEntry, type TradeRow } from "@blast/server/modules/social/trades/swap.ts";

/**
 * Social feed R3-31: the swap path's pure parts — what filled, the trade's
 * log row, who pays, and the signer boundary: the
 * server's trade code holds no key and signs nothing (AC-7).
 */

const SENDER = "0x0000000000000000000000000000000000000000000000000000000000000e3b";

const row: TradeRow = {
  trade_id: "00000000-0000-4000-8000-000000000001",
  account_id: "00000000-0000-4000-8000-0000000000a1",
  idempotency_key: "4a0b7c5e-8f3d-4b2a-9c1e-6d5f4e3a2b1c",
  quote_digest: Buffer.alloc(32),
  side: "buy",
  sender: SENDER,
  in_coin: SUI,
  out_coin: SALE_B,
  amount_in: "100000000",
  amount_out: "332001975262684891",
  min_out: "330341965386371466",
  slippage_bps: 50,
  route: [],
  route_label: "SUI → BEE · Cetus",
  usd_value: "0.12",
  fee_payer: "blast",
  reservation_id: "00000000-0000-4000-8000-0000000000aa",
  tx_bytes: Buffer.from([1, 2, 3]),
  digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
  expires_at_ms: "1791000110000",
  state: "built",
  failure_code: null,
  amount_out_filled: null,
  created_at_ms: "1791000000000",
  settled_at_ms: null,
};

test("what filled is the sender's gain in the coin; a SUI fill the wallet paid gas from adds the gas back", () => {
  const changes = [
    { coinType: SALE_B, address: SENDER, amount: "332001975262684800" },
    { coinType: SUI, address: SENDER, amount: "-100000000" },
    { coinType: SALE_B, address: "0x0000000000000000000000000000000000000000000000000000000000000bad", amount: "9" },
  ];
  assert.equal(filledOut({ success: true, sender: SENDER, balanceChanges: changes, gasMist: 0n, abort: null }, row), 332_001_975_262_684_800n);
  const sell = { ...row, in_coin: SALE_B, out_coin: SUI, fee_payer: "wallet" as const };
  const sold = [{ coinType: SUI, address: SENDER, amount: "3982156" }];
  assert.equal(filledOut({ success: true, sender: SENDER, balanceChanges: sold, gasMist: 1_500_000n, abort: null }, sell), 5_482_156n);
  assert.equal(filledOut({ success: true, sender: SENDER, balanceChanges: sold, gasMist: 1_500_000n, abort: null }, { ...sell, fee_payer: "blast" }), 3_982_156n);
});

test("a wallet-paid SUI fill excludes storage rebates from its bought amount", async () => {
  const client = { core: { getTransaction: async () => ({
    Transaction: {
      transaction: { sender: SENDER },
      effects: { status: { success: true, error: null }, gasUsed: { computationCost: "50", storageCost: "50", storageRebate: "200" } },
      balanceChanges: [{ coinType: SUI, address: SENDER, amount: "1100" }],
      timestampMs: 1792400000000,
      checkpoint: "326274009",
    },
  }) } } as unknown as ClientWithCoreApi;
  const executed = await fullnodeTradeLookup(() => client).executed(row.digest!);
  assert.ok(executed);
  assert.equal(executed.gasMist, -100n);
  assert.equal(executed.timestampMs, 1792400000000);
  assert.equal(executed.checkpoint, "326274009");
  assert.equal(filledOut(executed, { ...row, out_coin: SUI, fee_payer: "wallet" }), 1000n);
});

test("a trade's log row: trade_buy or trade_sell, what it gets as the coin and what it gives as the quote, keyed by the trade", () => {
  assert.deepEqual(tradeLogEntry(row), {
    accountId: row.account_id,
    kind: "trade_buy",
    idempotencyKey: `trade:${row.idempotency_key}`,
    txId: row.trade_id,
    coinType: SALE_B,
    amount: row.amount_out,
    quoteType: SUI,
    quoteAmount: row.amount_in,
    usdValue: "0.12",
  });
  assert.equal(tradeLogEntry({ ...row, side: "sell" }).kind, "trade_sell");
});

test("the bytes to sign are answered only while the trade is built", () => {
  assert.equal(tradeBody(row).transaction_bytes, "AQID");
  assert.deepEqual(tradeBody(row).network_fee, { payer: "blast", label: "Paid by Blast" });
  assert.equal(tradeBody({ ...row, state: "confirmed", amount_out_filled: "1", settled_at_ms: "1791000005000" }).transaction_bytes, null);
  assert.equal(tradeBody({ ...row, fee_payer: null, tx_bytes: null, digest: null, state: "failed", failure_code: "quote_expired" }).network_fee, null);
});

test("the server's trade code holds no key and signs nothing: it builds bytes for the wallet (R3-31-AC-7)", () => {
  const dir = new URL("./", import.meta.url);
  const sources = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "fixtures.ts");
  assert.ok(sources.includes("swap.ts") && sources.includes("quote.ts"));
  for (const name of sources) {
    const source = readFileSync(new URL(name, dir), "utf8");
    for (const pattern of [/keypairs/i, /Keypair/, /fromSecretKey/, /signTransaction\(/, /signAndExecute/, /executeTransaction\(/, /PRIVATE_KEY|SECRET_KEY|MNEMONIC/]) {
      assert.doesNotMatch(source, pattern, `${name} must not ${pattern}`);
    }
  }
});

test("verified ecosystem coin types can be quoted before their decimals are indexed", async () => {
  const deep = CORE_COINS.find((coin) => coin.symbol === "DEEP")!;
  const cetus = CORE_COINS.find((coin) => coin.symbol === "CETUS")!;
  const lookalike = `0x${"8".repeat(64)}::deep::DEEP`;
  const db = {
    async read<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
      const rows = sql === COIN_METADATA_SQL
        ? [{ coin_type: cetus.coinType, decimals: null, is_presale: false }]
        : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
  const coins = await readTradeCoins(db, [deep.coinType, cetus.coinType, lookalike], Date.now());
  assert.deepEqual([...coins.values()].map(({ coinType, symbol, decimals, usdPrice }) => [coinType, symbol, decimals, usdPrice]), [
    [deep.coinType, "DEEP", 6, null],
    [cetus.coinType, "CETUS", 9, null],
  ]);
});
