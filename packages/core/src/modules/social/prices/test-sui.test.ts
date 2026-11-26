import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "../contracts/create.ts";
import { assertChainReadThroughViews } from "../../database/modules.ts";
import { DISPLAY_PRICES } from "./test-sui.ts";

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
