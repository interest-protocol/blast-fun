import assert from "node:assert/strict";
import test from "node:test";

import type { SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";
import { paymentFunding } from "./CurvePayment";

const quote = { min_out: "123" } as SocialTradeQuote;

test("a routed payment above the balance is still priced from the refused quote", () => {
  assert.equal(paymentFunding(true, "insufficient-balance", quote), "123");
  assert.equal(paymentFunding(true, "ready", quote), "123");
  for (const status of ["idle", "quoting", "temporary-error", "expired", "no-route"] as const) {
    assert.equal(paymentFunding(true, status, quote), null, status);
  }
  assert.equal(paymentFunding(true, "insufficient-balance", null), null);
  assert.equal(paymentFunding(false, "insufficient-balance", quote), undefined, "unrouted pays with the typed amount");
});
