import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "../contracts/create.ts";
import { assertChainReadThroughViews } from "../../database/modules.ts";
import { DISPLAY_PRICES, testSuiPriceEnabled } from "./test-sui.ts";

test("simulated TSUI pricing requires an explicit non-production setting", () => {
  assert.equal(testSuiPriceEnabled({}), false);
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true" }), false);
  for (const VERCEL_ENV of ["preview", "development"]) {
    assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", VERCEL: "1", VERCEL_ENV }), true);
    assert.equal(testSuiPriceEnabled({ VERCEL: "1", VERCEL_ENV }), false);
  }
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", BLAST_DEPLOYMENT_TARGET: "preview" }), true);
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", NODE_ENV: "test" }), true);
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", NODE_ENV: "production" }), false);
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", NODE_ENV: "test", VERCEL: "1", VERCEL_ENV: "production" }), false);
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", NODE_ENV: "test", BLAST_DEPLOYMENT_TARGET: "production" }), false);
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", NODE_ENV: "test", BLAST_WORKER_ENVIRONMENT: "production" }), false, "the one named change: a production worker stays off");
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", BLAST_WORKER_ENVIRONMENT: "development" }), false, "an unset NODE_ENV stays off on a non-production worker");
  assert.equal(testSuiPriceEnabled({ BLAST_TEST_SUI_PRICE_ENABLED: "true", NODE_ENV: "test", BLAST_WORKER_ENVIRONMENT: "development" }), true);
});

test("the display relation keeps exact identities and bounded fresh SUI, and estimates no pool marks", () => {
  const relation = DISPLAY_PRICES;
  assertChainReadThroughViews(`SELECT coin_type, usd_price FROM ${relation} prices`);
  assert.match(relation, new RegExp(CREATE_SUI_QUOTE_TYPE));
  assert.match(relation, new RegExp(CREATE_TEST_SUI_QUOTE_TYPE));
  assert.match(relation, /as_of_ms BETWEEN[\s\S]*120000[\s\S]*AND extract/);
  assert.match(relation, /usd_price > 0/);
  assert.match(relation, /test_sui_proxy/);
  assert.doesNotMatch(relation, /presale_pool_prices|test_sui_pool_proxy/);
  assert.doesNotMatch(relation, /\b(?:INSERT|UPDATE|DELETE|price_history)\b/);
});
