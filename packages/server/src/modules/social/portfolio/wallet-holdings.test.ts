import assert from "node:assert/strict";
import test from "node:test";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { readWalletHoldings, walletHoldingExactValue, walletHoldingValue, type WalletHolding } from "./wallet-holdings.ts";
import { atomsToUsdExact } from "@blast/core/modules/social/portfolio/read.ts";

test("unpriced holdings stay unknown while priced dust remains distinguishable from zero", () => {
  const now = 1_790_000_000_000;
  const holding: WalletHolding = {
    coin_type: "0xa::test_sui::TEST_SUI", balance: "10000000000000000",
    name: "Test SUI", symbol: "TSUI", decimals: 9, icon_url: null,
    presale_id: null, price: null, priceUnavailable: false,
  };
  assert.equal(walletHoldingValue(holding, now), null);
  assert.equal(walletHoldingValue({ ...holding, decimals: null }, now), null);
  assert.equal(walletHoldingValue({ ...holding, balance: "0", priceUnavailable: true }, now), "0.00");
  assert.equal(walletHoldingExactValue({ ...holding, balance: "0", priceUnavailable: true }, now), "0");
  assert.equal(walletHoldingValue({ ...holding, priceUnavailable: true }, now), null);
  assert.equal(walletHoldingValue({ ...holding, price: { usd_price: "2", as_of_ms: now - 121_000 } }, now), null);
  assert.equal(walletHoldingValue({ ...holding, balance: "2500000000", price: { usd_price: "2", as_of_ms: now } }, now), "5.00");
  const dust = { ...holding, balance: "1", price: { usd_price: "0.000000000000123456789", as_of_ms: now } };
  assert.equal(walletHoldingValue(dust, now), "0.00", "cent-based totals keep their existing contract");
  assert.equal(walletHoldingExactValue(dust, now), "0.000000000000000000000123456789");
  assert.equal(walletHoldingExactValue({ ...dust, price: { ...dust.price, usd_price: "0" } }, now), "0", "a real zero price is distinguishable from dust");
  for (const unknown of [holding, { ...dust, priceUnavailable: true }, { ...dust, decimals: null }, { ...dust, price: { ...dust.price, as_of_ms: now - 121_000 } }])
    assert.equal(walletHoldingExactValue(unknown, now), null);
  assert.equal(walletHoldingValue({ ...holding, balance: "0" }, now), "0.00");
  assert.equal(walletHoldingExactValue({ ...holding, balance: "0" }, now), "0");
});

test("exact USD valuation preserves large atom counts and every decimal place", () => {
  assert.equal(atomsToUsdExact("9007199254740993", 6, "1"), "9007199254.740993");
  assert.equal(atomsToUsdExact("15", 0, "2"), "30");
  assert.equal(atomsToUsdExact("15", 2, "2.50"), "0.375");
  assert.equal(atomsToUsdExact("1", 255, "1"), `0.${"0".repeat(254)}1`);
  for (const [atoms, decimals, price] of [["-1", 9, "1"], ["1", -1, "1"], ["1", 256, "1"], ["1", 1.5, "1"], ["1", 9, "NaN"], ["1", 9, "1e-9"]] as const)
    assert.equal(atomsToUsdExact(atoms, decimals, price), null);
});

test("missing metadata uses the outer coin name, including nested and multiple type arguments", async () => {
  const coins = [
    { coin_type: "0xa::reserve::MarketCoin<0x2::sui::SUI>", symbol: null, expected: "MarketCoin" },
    { coin_type: "0xb::house::StakedHouseCoin<0x2::sui::SUI>", symbol: null, expected: "StakedHouseCoin" },
    { coin_type: "0xa::pool::LP<0xb::vault::Share<0x2::sui::SUI>, 0xc::usdc::USDC>", symbol: null, expected: "LP" },
    { coin_type: "0xa::test_sui::TEST_SUI", symbol: null, expected: "TEST_SUI" },
    { coin_type: "0xa::abyss_vault::AToken<0x2::sui::SUI>", symbol: "aSUI", expected: "aSUI" },
  ];
  const rows = coins.map(({ coin_type, symbol }) => ({
    owner: "0x1", status: "ready", checkpoint: "1", timestamp_ms: "1",
    coin_type, symbol, balance: "1", name: null, decimals: null, icon_url: null,
    presale_id: null, usd_price: null, as_of_ms: null,
  }));
  const db: ReadableDatabase = {
    async read<Row>() {
      return { rows: rows as unknown as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
  const { holdings } = await readWalletHoldings(db, ["0x1"]);
  assert.deepEqual(holdings.map(({ coin_type, symbol }) => [coin_type, symbol]), coins.map(({ coin_type, expected }) => [coin_type, expected]));
});

test("wallet totals use every owner and sync reports the oldest ready snapshot, including empty wallets", async () => {
  const rows = [
    { owner: "0x1", status: "ready", checkpoint: "20", timestamp_ms: "200", balance: "3" },
    { owner: "0x2", status: "ready", checkpoint: "10", timestamp_ms: "100", balance: "4" },
    { owner: "0x3", status: "ready", checkpoint: "15", timestamp_ms: null, balance: null },
  ].map((row) => ({ ...row, coin_type: row.balance === null ? null : "0x2::sui::SUI", name: null, symbol: "SUI", decimals: 9, icon_url: null, presale_id: null, usd_price: null, as_of_ms: null }));
  const db: ReadableDatabase = {
    async read<Row>() {
      return { rows: rows as unknown as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
  const result = await readWalletHoldings(db, ["0x1", "0x2", "0x3"]);
  assert.equal(result.holdings[0]?.balance, "7");
  assert.deepEqual(result.sync, { status: "ready", checkpoint: "10", as_of_ms: 100 });
  rows[2]!.status = "syncing";
  assert.deepEqual((await readWalletHoldings(db, ["0x1", "0x2", "0x3"])).sync, { status: "syncing", checkpoint: null, as_of_ms: 100 });
  rows[1]!.status = "stale";
  assert.deepEqual((await readWalletHoldings(db, ["0x1", "0x2", "0x3"])).sync, { status: "stale", checkpoint: null, as_of_ms: 100 });
  assert.deepEqual(await readWalletHoldings(db, []), { holdings: [], sync: { status: "ready", checkpoint: null, as_of_ms: null } });
});
