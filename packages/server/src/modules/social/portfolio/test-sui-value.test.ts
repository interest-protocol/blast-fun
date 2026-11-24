import assert from "node:assert/strict";
import test from "node:test";

import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { valueCommitments, type ValuedPosition } from "./position-value.ts";

test("test SUI commitments and refunds have zero value independently of the SUI price", () => {
  const now = 1_800_000_000_000;
  const position: ValuedPosition = { commitment: "125123456789", status: "open", quote_symbol: "TSUI", quote_type: CREATE_TEST_SUI_QUOTE_TYPE, quote_decimals: 9 };
  const price = { usd_price: "3.4187", as_of_ms: now - 30_000 };
  assert.deepEqual(valueCommitments([position], { sui: price }, now), {
    commitments: { committed_usd: "0.00", claimable_usd: "0.00", has_priced_holdings: true }, pricesAsOfMs: null,
  });
  const unrelated = { ...position, quote_type: "another::test_sui::TEST_SUI" };
  assert.equal(valueCommitments([unrelated], { sui: price }, now).commitments.committed_usd, null);
  const partialClaim: ValuedPosition = { ...position, status: "claimable", claimable: {
    tokens: "3000000000", quote_refund: "1000000000", sale_decimals: 9, price: { usd_price: "1.25", as_of_ms: now - 1_000 },
  } };
  assert.deepEqual(valueCommitments([partialClaim], {}, now), {
    commitments: { committed_usd: "0.00", claimable_usd: "3.75" }, pricesAsOfMs: now - 1_000,
  });
});
