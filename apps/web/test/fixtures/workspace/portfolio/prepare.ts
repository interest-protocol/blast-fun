import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { migrateDatabase } from "@blast/core/modules/database/migrations.ts";
import { CHAIN_FIXTURE } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { seedChainRead } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { fixtureCoinType, FIXTURE_SUI, FIXTURE_USDC } from "../../social/trade/trade-fixtures.ts";
import { portfolioFixtureConfiguration, portfolioAccountId, portfolioAddress, portfolioSaleId } from "./configuration.ts";
import { supportedPortfolioAssets } from "./supported-assets.ts";
const { directory, url } = portfolioFixtureConfiguration();
const pool = createPool(url, { max: 1 });
const now = Date.now();
try {
  const schema = await pool.query("SELECT to_regclass('social_blast_workspaces') AS name");
  if (!schema.rows[0].name) { await pool.query(CHAIN_FIXTURE); await migrateDatabase(pool); }
  if ((await pool.query("SELECT 1 FROM social_accounts WHERE privy_did LIKE 'did:privy:t020-%'")).rowCount)
    throw new Error("Portfolio fixture already prepared; reuse without reseeding");
  for (let n = 1; n <= 3; n++) await pool.query("INSERT INTO social_accounts(account_id,privy_did,callsign,privacy) VALUES($1,$2,$3,'private')", [portfolioAccountId(n), `did:privy:t020-${n}`, `t020_${n}`]);
  for (const [wallet, account] of [[1, 1], [2, 1], [3, 2]]) {
    await pool.query("INSERT INTO social_account_wallets(address,account_id,verified_at) VALUES($1,$2,now())", [portfolioAddress(wallet), portfolioAccountId(account)]);
    await pool.query("INSERT INTO blast_infra_fixture.wallet_sync(owner,status,timestamp_ms) VALUES($1,'ready',$2)", [portfolioAddress(wallet), now]);
  }
  const symbols = ["KSTL", "LUMN", "ODD", ...Array.from({ length: 21 }, (_, n) => `ASSET${n}`)];
  await seedChainRead(pool, {
    coin_metadata: symbols.map(symbol => ({ coin_type: fixtureCoinType(symbol), name: symbol === "KSTL" ? "Kestrel" : symbol === "ODD" ? "Unknown metadata" : symbol, symbol, decimals: symbol === "ODD" ? null : 9, description: null, icon_url: null })),
    coin_balances: [
      { owner: portfolioAddress(1), coin_type: FIXTURE_SUI, balance: "4000000000", updated_checkpoint: 1 },
      { owner: portfolioAddress(1), coin_type: FIXTURE_USDC, balance: "100000000", updated_checkpoint: 1 },
      { owner: portfolioAddress(2), coin_type: FIXTURE_USDC, balance: "23450000", updated_checkpoint: 1 },
      { owner: portfolioAddress(3), coin_type: FIXTURE_USDC, balance: "73000000", updated_checkpoint: 1 },
      ...symbols.map(symbol => ({ owner: portfolioAddress(1), coin_type: fixtureCoinType(symbol), balance: symbol === "KSTL" ? "600000000000001" : "1", updated_checkpoint: 1 })),
    ],
    prices: [
      { coin_type: FIXTURE_SUI, usd_price: "3.42", as_of_ms: now, source: "pyth" },
      { coin_type: fixtureCoinType("KSTL"), usd_price: "0.0021", as_of_ms: now, source: "pool" },
      { coin_type: fixtureCoinType("LUMN"), usd_price: "0.0013", as_of_ms: now - 121000, source: "pool" },
      { coin_type: fixtureCoinType("ODD"), usd_price: "1", as_of_ms: now - 121000, source: "pool" },
    ],
    presales: [...supportedPortfolioAssets(now), { presale_id: portfolioSaleId, sale_token: `0x${"5".repeat(64)}::kestrel::KSTL`, quote_type: FIXTURE_USDC, sale_symbol: "SALE", sale_name: "Sale position", sale_icon_url: "", sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle: "open", start_ms: now - 3600000, end_ms: now + 86400000, raise_target: "10000000000", min_commitment: "1000000", wallet_cap: null, total_commitments: "123450001", participants: 1, venue: "cetus", pool_id: null, updated_checkpoint: 1 }],
    presale_positions: [{ presale_id: portfolioSaleId, wallet: portfolioAddress(1), commitment: "123450001", last_commit_ms: now - 1000, claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null }],
  });
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(`${directory}/auth.json`, JSON.stringify({ now, privateKey: keys.privateKey.export({ format: "pem", type: "pkcs8" }), publicKey: keys.publicKey.export({ format: "pem", type: "spki" }) }), { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, accounts: 3, wallets: 3, holdings: 28, presales: 3, positions: 1, clock_ms: now }));
} finally { await pool.end(); }
