import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { readLaunchDetails } from "@blast/server/modules/social/launch/details.ts";
import { seedChainRead, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { readCoinMetadata } from "./coin-metadata.ts";

const objectId = (digit: string) => `0x${digit.repeat(64)}`;
const coinType = (digit: string) => `${objectId(digit)}::coin::COIN`;

test("coin metadata uses the reader and includes confirmed launch details before coin indexing", async (t) => {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 1 });
  const web = createPool(urlAs(database.url, "blast_web"), { max: 1 });
  const replica = createPool(urlAs(database.url, "blast_replica"), { max: 1 });
  t.after(async () => {
    await Promise.all([admin.end(), web.end(), replica.end()]);
    await database.drop();
  });
  const external = coinType("a");
  const curve = coinType("b");
  const presale = coinType("c");
  const sale: ChainPresaleRow = {
    presale_id: objectId("2"), sale_token: presale, sale_symbol: "COIN", sale_name: "Coin",
    sale_icon_url: "https://sale.example/icon.png", sale_decimals: 9, quote_type: CREATE_SUI_QUOTE_TYPE, quote_symbol: "SUI",
    quote_decimals: 9, lifecycle: "open", start_ms: 1, end_ms: 2, raise_target: "100",
    min_commitment: "1", wallet_cap: null, total_commitments: "0", participants: 0,
    venue: "cetus", pool_id: null, updated_checkpoint: 1,
  };
  await seedChainRead(admin, {
    coin_metadata: [{
      coin_type: external, name: "Coin", symbol: "COIN", icon_url: null, decimals: 9,
      description: 'Coin||{"website":"https://chain.example","twitter":"https://x.com/chaincoin"}',
    }],
    presales: [sale, { ...sale, presale_id: objectId("1"), quote_type: CREATE_TEST_SUI_QUOTE_TYPE }],
  });
  await admin.query(`
    INSERT INTO social_sale_metadata (presale_id, site, updated_by_operator, updated_at_ms)
      VALUES ($1, 'https://test-sale.example', 'operator', 1), ($2, 'https://sale.example', 'operator', 1)
  `, [objectId("1"), sale.presale_id]);
  const launchId = objectId("d");
  await admin.query(`
    INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
      VALUES ($1, 'blast_curve', $2, $3, 'active', 1, 1)
  `, [`blast_curve:${launchId}`, curve, CREATE_SUI_QUOTE_TYPE]);
  const accountId = "00000000-0000-0000-0000-000000000001";
  await admin.query(`
    INSERT INTO social_accounts (account_id, privy_did, callsign)
      VALUES ($1, 'did:privy:coin-metadata-test', 'metadatafixture')
  `, [accountId]);
  await admin.query(`
    INSERT INTO social_launch_drafts (draft_id, account_id, version, body, coin_type, published_launch_id, published_at)
      VALUES
        (gen_random_uuid(), $1, 1, '{"site":"https://unpublished.example"}', $2, NULL, NULL),
        (gen_random_uuid(), $1, 1, '{"site":"https://curve.example","tagline":"","docs_url":"","audit_url":"","x_handle":"","telegram":"curvecoin"}', $3, $4, now())
  `, [accountId, external, curve, launchId]);

  const db = autocommitReader(replica, "social");
  const launchReads: string[] = [];
  const read = (type: string) => readCoinMetadata(db, type, (id) => {
    launchReads.push(id);
    return readLaunchDetails(id, autocommitReader(web, "social"));
  });
  assert.deepEqual((await read(external))?.links, {
    website: "https://chain.example/", x: "https://x.com/chaincoin", telegram: null, docs: null, audit: null,
  });
  const launch = await read(curve);
  assert.equal(launch?.links.website, "https://curve.example");
  assert.equal(launch?.links.telegram, "https://t.me/curvecoin");
  assert.equal(launch?.name, null);
  const saleMetadata = await read(presale);
  assert.equal(saleMetadata?.name, sale.sale_name);
  assert.equal(saleMetadata?.symbol, sale.sale_symbol);
  assert.equal(saleMetadata?.decimals, sale.sale_decimals);
  assert.equal(saleMetadata?.icon_url, sale.sale_icon_url);
  assert.equal(saleMetadata?.links.website, "https://sale.example");
  assert.equal(await read(coinType("f")), null);
  assert.deepEqual(launchReads, [launchId]);
});
