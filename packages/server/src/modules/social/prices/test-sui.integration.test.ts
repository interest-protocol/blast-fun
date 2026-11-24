import assert from "node:assert/strict";
import test from "node:test";

import pg, { type QueryResultRow } from "pg";

import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE, TEST_SUI_COIN_TYPES } from "@blast/core/modules/social/contracts/create.ts";
import { assertReadOnlyStatement, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("wallets value test SUI at zero while the test-market price follows SUI", { skip: !databaseUrl }, async (t) => {
  const database = await freshTestDatabase();
  t.after(database.drop);
  const client = new pg.Client({ connectionString: database.url });
  await client.connect();
  try {
    const { DISPLAY_PRICES } = await import("@blast/core/modules/social/prices/test-sui.ts");
    const { readWalletHoldings, readWalletHoldingsBatch, walletHoldingValue } = await import("../portfolio/wallet-holdings.ts");
    const { walletCoins } = await import("../coins/wallet.ts");
    const { readPortfolioCoinPage } = await import("../portfolio/coin-page.ts");
    const db: ReadableDatabase = {
      async read<Row extends QueryResultRow>(sql: string, values?: readonly unknown[]) {
        assertReadOnlyStatement(sql);
        return client.query<Row>(sql, values ? [...values] : undefined);
      },
    };
    await client.query("BEGIN");
    const now = Date.now();
    const otherTestSui = TEST_SUI_COIN_TYPES[1]!;
    await client.query("INSERT INTO blast_infra_fixture.prices VALUES ($1, 5, $2, 'pool')", [otherTestSui, now]);
    await client.query("INSERT INTO blast_infra_fixture.prices VALUES ($1, 3.4187, $2, 'pyth'), ('real-sale', 9, $2, 'pool')", [CREATE_SUI_QUOTE_TYPE, now - 1_000]);
    await client.query(`INSERT INTO blast_infra_fixture.presale_pool_prices VALUES
      ('sale', 'sale-coin', $1, 'TSUI', 0.25, $2),
      ('real', 'real-sale', $1, 'TSUI', 2, $2),
      ('unrelated', 'unrelated-coin', 'another::test_sui::TEST_SUI', 'TSUI', 2, $2)`, [CREATE_TEST_SUI_QUOTE_TYPE, now - 5_000]);
    await client.query(`INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals)
      VALUES ($1,'Test SUI','TSUI',9), ('sale-coin','Sale','SALE',9), ('unpriced-coin','Unpriced','UNKNOWN',9)`, [CREATE_TEST_SUI_QUOTE_TYPE]);
    await client.query(`INSERT INTO blast_infra_fixture.coin_balances VALUES
      ($1,'wallet',2000000000,1), ('sale-coin','wallet',2000000000,1), ('unpriced-coin','wallet',1000000000,1),
      ($2,'wallet',3000000000,1)`, [CREATE_TEST_SUI_QUOTE_TYPE, otherTestSui]);
    await client.query("INSERT INTO blast_infra_fixture.wallet_sync (owner,timestamp_ms) VALUES ('wallet',$1)", [now]);
    await client.query(`INSERT INTO blast_infra_fixture.presales
      (presale_id,sale_token,quote_type,sale_symbol,sale_name,sale_icon_url,sale_decimals,quote_symbol,quote_decimals,lifecycle,start_ms,end_ms,raise_target,min_commitment,total_commitments,participants,venue,pool_id,updated_checkpoint)
      VALUES ('sale','sale-coin',$1,'SALE','Sale','https://example.test/sale.png',9,'TSUI',9,'migrated',0,1,1,1,1,1,'bluefin','pool',1)`, [CREATE_TEST_SUI_QUOTE_TYPE]);
    const balances = new Map([[CREATE_TEST_SUI_QUOTE_TYPE, 2_000_000_000n], [otherTestSui, 3_000_000_000n], [CREATE_SUI_QUOTE_TYPE, 1_000_000_000n]]);
    const assertWalletValues = async () => {
      const wallet = await readWalletHoldings(db, ["wallet"]);
      const batch = (await readWalletHoldingsBatch(db, new Map([["account", ["wallet"]]]))).get("account");
      const page = await readPortfolioCoinPage(db, ["wallet"], 1, "", now);
      const sheet = await walletCoins(db, balances, now);
      for (const [type, balance] of [[CREATE_TEST_SUI_QUOTE_TYPE, "2000000000"], [otherTestSui, "3000000000"]] as const) {
        const holding = wallet.holdings.find((coin) => coin.coin_type === type)!;
        const pageCoin = page.coins.find((coin) => coin.coin_type === type);
        const sheetCoin = sheet.find((coin) => coin.coin_type === type);
        assert.deepEqual([holding.balance, walletHoldingValue(holding, now)], [balance, "0.00"]);
        assert.deepEqual(batch?.holdings.find((coin) => coin.coin_type === type), holding);
        assert.deepEqual([pageCoin?.balance, pageCoin?.value_usd, pageCoin?.value_usd_exact], [balance, "0.00", "0"]);
        assert.deepEqual([sheetCoin?.atoms, sheetCoin?.usd_price, sheetCoin?.value_usd], [balance, "0", "0.00"]);
      }
      for (const type of ["sale-coin", "unpriced-coin"]) {
        const holding = wallet.holdings.find((coin) => coin.coin_type === type)!;
        assert.equal(walletHoldingValue(holding, now), null);
        assert.equal(page.coins.find((coin) => coin.coin_type === type)?.value_usd, null);
      }
      return sheet.find((coin) => coin.coin_type === CREATE_SUI_QUOTE_TYPE)?.value_usd;
    };
    assert.equal(await assertWalletValues(), "3.42");
    const testMarketPrice = async () => (await client.query(
      `SELECT usd_price::text, source FROM ${DISPLAY_PRICES} p WHERE coin_type = $1`, [CREATE_TEST_SUI_QUOTE_TYPE],
    )).rows;
    assert.deepEqual(await testMarketPrice(), [{ usd_price: "3.4187", source: "test_sui_proxy" }]);
    for (const [usd, age] of [["3.4187", 121_000], ["0", 1_000], ["3.4187", -60_000]] as const) {
      await client.query("UPDATE blast_infra_fixture.prices SET usd_price=$1, as_of_ms=$2 WHERE coin_type=$3", [usd, now - age, CREATE_SUI_QUOTE_TYPE]);
      assert.deepEqual(await testMarketPrice(), []);
    }
    await client.query("DELETE FROM blast_infra_fixture.prices WHERE coin_type=$1", [CREATE_SUI_QUOTE_TYPE]);
    await client.query("INSERT INTO blast_infra_fixture.coin_unavailable(coin_type,scope) VALUES ($1,'pool_price')", [CREATE_TEST_SUI_QUOTE_TYPE]);
    assert.equal(await assertWalletValues(), null);
    assert.deepEqual(await testMarketPrice(), []);
    assert.equal((await client.query("SELECT count(*)::int n FROM chain_read_v1.price_history")).rows[0].n, 0);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
