import assert from "node:assert/strict";
import test from "node:test";

import { CREATE_WAL_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { offeredQuotes } from "@blast/server/modules/social/create/route.ts";
test("the picker offers a listed quote without a separate test gate", () => {
  assert.deepEqual(offeredQuotes(null, [CREATE_TEST_SUI_QUOTE_TYPE]), [CREATE_TEST_SUI_QUOTE_TYPE]);
  assert.deepEqual(offeredQuotes(null, [CREATE_QUOTE_TYPE]), [CREATE_QUOTE_TYPE]);
  assert.deepEqual(offeredQuotes(null, null), []);
});

test("the picker excludes USDC when the deployed policy allows only SUI and TEST_SUI", () => {
  const allowed = [CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE];
  assert.deepEqual(offeredQuotes({ usd_price: "2", as_of_ms: 1 }, allowed), allowed);
  assert.deepEqual(offeredQuotes(null, allowed), [CREATE_TEST_SUI_QUOTE_TYPE]);
  assert.deepEqual(offeredQuotes({ usd_price: "2", as_of_ms: 1 }, null), []);
});


test("USDsui is offered without a SUI price only when the deployed policy admits it", () => {
  const allowed = [CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE];
  assert.deepEqual(offeredQuotes(null, allowed), [CREATE_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE]);
  assert.deepEqual(offeredQuotes({ usd_price: "2", as_of_ms: 1 }, allowed), allowed);
  assert.deepEqual(offeredQuotes(null, [CREATE_QUOTE_TYPE]), [CREATE_QUOTE_TYPE]);
  assert.deepEqual(offeredQuotes(null, [CREATE_USDSUI_QUOTE_TYPE]), [CREATE_USDSUI_QUOTE_TYPE]);
});


test("WAL is offered without a SUI price only when the deployed policy admits it", () => {
  assert.deepEqual(offeredQuotes(null, [CREATE_WAL_QUOTE_TYPE]), [CREATE_WAL_QUOTE_TYPE]);
  assert.deepEqual(offeredQuotes(null, [CREATE_QUOTE_TYPE]), [CREATE_QUOTE_TYPE]);
  assert.deepEqual(offeredQuotes(null, null), []);
});
