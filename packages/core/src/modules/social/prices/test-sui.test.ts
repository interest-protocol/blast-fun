import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "../contracts/create.ts";
import { assertChainReadThroughViews } from "../../database/modules.ts";
import { chainPriceOf } from "./keyed.ts";
import { displayPriceOf, displayPricesIn } from "./test-sui.ts";

test("the display relation keeps exact identities and bounded fresh SUI, and estimates no pool marks", () => {
  const relation = displayPricesIn("$1::text[]");
  assertChainReadThroughViews(`SELECT coin_type, usd_price FROM ${relation} prices`);
  assert.match(relation, new RegExp(CREATE_SUI_QUOTE_TYPE));
  assert.match(relation, new RegExp(CREATE_TEST_SUI_QUOTE_TYPE));
  assert.match(relation, /as_of_ms BETWEEN[\s\S]*120000[\s\S]*AND extract/);
  assert.match(relation, /usd_price > 0/);
  assert.match(relation, /test_sui_proxy/);
  assert.doesNotMatch(relation, /presale_pool_prices|test_sui_pool_proxy/);
  assert.doesNotMatch(relation, /\b(?:INSERT|UPDATE|DELETE|price_history)\b/);
});

test("every display price read is keyed and fenced to one row", () => {
  assert.match(displayPricesIn("$1::text[]"), /WHERE display_price\.coin_type = ANY\(\$1::text\[\]\)\)$/);
  const probe = displayPriceOf("p.sale_token", "p.lifecycle = 'migrated'");
  assertChainReadThroughViews(`SELECT pr.usd_price FROM (SELECT 'x' AS sale_token, 'migrated' AS lifecycle) p LEFT JOIN ${probe} pr ON TRUE`);
  assert.match(probe, /^LATERAL \(/);
  assert.match(probe, /WHERE display_price\.coin_type = p\.sale_token AND \(p\.lifecycle = 'migrated'\) LIMIT 1\)$/);
});

test("the chain price probe is keyed and fenced to one row", () => {
  assert.match(chainPriceOf("h.coin_type"), /^LATERAL \(SELECT [^)]* FROM chain_read_v1\.prices chain_price\s+WHERE chain_price\.coin_type = h\.coin_type LIMIT 1\)$/);
});

test("no source joins chain_read_v1.prices on a column: it reads by key through the helpers", () => {
  const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
  const files = globSync(["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"], { cwd: root, exclude: (name) => name === "node_modules" })
    .filter((file) => !/\.test\.tsx?$/.test(file));
  assert.ok(files.length > 100, `found ${files.length} sources`);
  const joined = files.filter((file) => /JOIN\s+chain_read_v1\.prices\s+\w+\s+ON\b/i.test(readFileSync(root + file, "utf8")));
  assert.deepEqual(joined, []);
});
