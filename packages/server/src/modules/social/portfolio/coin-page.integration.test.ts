import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { readPortfolioCoinPage } from "./coin-page.ts";
import { readWalletHoldings, walletHoldingExactValue, walletHoldingValue } from "./wallet-holdings.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("paged and full holdings distinguish missing, stale, zero and sub-cent prices", { skip: !databaseUrl }, async () => {
  // Migrated, so the reads find the trust tables (`verifiedTeamSql`) as production does.
  const { url } = await freshTestDatabase();
  const pool = new Pool({ connectionString: url, max: 1 });
  const now = 1_800_000_000_000;
  const owner = `0x${"ab".repeat(32)}`;
  const cases = [
    { symbol: "UNKNOWN", price: null, decimals: 9, balance: "1000000000", usd: null, exact: null },
    { symbol: "STALE", price: "1", decimals: 9, balance: "1000000000", usd: null, exact: null },
    { symbol: "DUST", price: "0.000000000000123456789", decimals: 9, balance: "1", usd: "0.00", exact: "0.000000000000000000000123456789" },
    { symbol: "TINY", price: "0.12345678901234567890123456789", decimals: 255, balance: "1", usd: "0.00", exact: `0.${"0".repeat(255)}12345678901234567890123456789` },
    { symbol: "ZERO", price: "0", decimals: 9, balance: "1000000000", usd: "0.00", exact: "0" },
    { symbol: "VALUED", price: "2.5", decimals: 9, balance: "2000000000", usd: "5.00", exact: "5" },
  ];
  // The production reader, so its statement guard runs too: a `;` in a SQL comment once failed every live read (503).
  const db = autocommitReader(pool, "social", { prepare: true });
  try {
    await pool.query("INSERT INTO blast_infra_fixture.wallet_sync(owner,timestamp_ms) VALUES ($1,$2)", [owner, now]);
    for (const coin of cases) {
      const type = `0xab::valuation::${coin.symbol}`;
      await pool.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,$3,80001)", [type, owner, coin.balance]);
      await pool.query("INSERT INTO blast_infra_fixture.coin_metadata(coin_type,symbol,decimals) VALUES ($1,$2,$3)", [type, coin.symbol, coin.decimals]);
      if (coin.price !== null) await pool.query("INSERT INTO blast_infra_fixture.prices VALUES ($1,$2,$3,'pool')", [type, coin.price, coin.symbol === "STALE" ? now - 121_000 : now]);
    }
    const page = await readPortfolioCoinPage(db, [owner], 1, "0xab::valuation::", now);
    const wallet = await readWalletHoldings(db, [owner]);
    assert.equal(page.total, cases.length);
    assert.equal(page.wallet_has_coins, true);
    for (const expected of cases) {
      const coin = page.coins.find(row => row.symbol === expected.symbol)!;
      const holding = wallet.holdings.find(row => row.symbol === expected.symbol)!;
      assert.deepEqual([coin.value_usd, coin.value_usd_exact], [expected.usd, expected.exact], expected.symbol);
      assert.equal(walletHoldingValue(holding, now), expected.usd);
      assert.equal(walletHoldingExactValue(holding, now), expected.exact);
    }
    const absent = await readPortfolioCoinPage(db, [], 1, "USDC", now);
    assert.deepEqual(absent.coins, []);
    assert.equal(absent.wallet_has_coins, false);
    // Two letters that occur only inside the address match nothing; written as a coin type they still find it.
    assert.deepEqual((await readPortfolioCoinPage(db, [owner], 1, "ab", now)).coins, []);
    assert.equal((await readPortfolioCoinPage(db, [owner], 1, "ab::valuation::dust", now)).total, 1);
    const noMatch = await readPortfolioCoinPage(db, [owner], 1, "zzzz", now);
    assert.deepEqual(noMatch.coins, []);
    assert.equal(noMatch.wallet_has_coins, true);
    // A curated coin pairs its curated symbol with its curated name, so Hashi BTC (indexed as hBTC, "BTC") never reads hashiBTC · BTC.
    const hashi = "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC";
    await pool.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,$3,80001)", [hashi, owner, "100000000"]);
    await pool.query("INSERT INTO blast_infra_fixture.coin_metadata(coin_type,symbol,name,decimals) VALUES ($1,'hBTC','BTC',8)", [hashi]);
    // An address pasted without 0x finds its coin from six hex digits; five could be a stray run inside any address.
    assert.deepEqual((await readPortfolioCoinPage(db, [owner], 1, "D30FB3F8", now)).coins.map(row => row.coin_type), [hashi]);
    assert.deepEqual((await readPortfolioCoinPage(db, [owner], 1, "d30fb", now)).coins, []);
    const curated = await readPortfolioCoinPage(db, [owner], 1, "hashi", now);
    assert.deepEqual(curated.coins.map(row => [row.symbol, row.name]), [["hashiBTC", "Hashi BTC"]]);
    const filtered = await readPortfolioCoinPage(db, [owner], 1, "DUST", now, true);
    assert.deepEqual(filtered.coins, []);
    assert.equal(filtered.wallet_has_coins, true);
    // A Blast curve coin's row carries its launch id (the curve pool) for /coin/<launch_id>; a coin Blast did not launch carries null.
    const launchId = `0x${"cd".repeat(32)}`;
    const launched = "0xab::launched::CURVE";
    await pool.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,'5',80001)", [launched, owner]);
    await pool.query("INSERT INTO coins (coin_type, decimals, launcher, pool_key, created_checkpoint, created_at_ms) VALUES ($1, 9, '0xc0ffee', $2, 900, 1790000000000)", [launched, `blast_curve:${launchId}`]);
    await pool.query("INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms) VALUES ($1, 'blast_curve', $2, '0x2::sui::SUI', 'migrated', 900, 1790000000000)", [`blast_curve:${launchId}`, launched]);
    // A presale token links to its presale, never to a curve pool that trades it.
    const sold = "0xab::launched::SALE";
    const salePool = `blast_curve:0x${"ef".repeat(32)}`;
    await pool.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,'5',80001)", [sold, owner]);
    await pool.query(`INSERT INTO blast_infra_fixture.presales
      (presale_id,sale_token,quote_type,sale_symbol,sale_name,sale_icon_url,sale_decimals,quote_symbol,quote_decimals,lifecycle,start_ms,end_ms,raise_target,min_commitment,total_commitments,participants,venue,pool_id,updated_checkpoint)
      VALUES ('sold-sale',$1,'0x2::sui::SUI','SALE','Sale','https://example.test/sale.png',9,'SUI',9,'migrated',0,1,1,1,1,1,'bluefin','pool',1)`, [sold]);
    await pool.query("INSERT INTO coins (coin_type, decimals, launcher, pool_key, created_checkpoint, created_at_ms) VALUES ($1, 9, '0xc0ffee', $2, 900, 1790000000000)", [sold, salePool]);
    await pool.query("INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms) VALUES ($1, 'blast_curve', $2, '0x2::sui::SUI', 'migrated', 900, 1790000000000)", [salePool, sold]);
    const rows = (await readPortfolioCoinPage(db, [owner], 1, "0xab::", now)).coins;
    assert.equal(rows.find(row => row.coin_type === launched)?.launch_id, launchId);
    assert.deepEqual(rows.filter(row => row.coin_type === sold).map(row => [row.presale_id, row.launch_id]), [["sold-sale", null]]);
    assert.ok(rows.filter(row => row.coin_type !== launched).every(row => row.launch_id === null));
  } finally {
    await pool.end();
  }
});
