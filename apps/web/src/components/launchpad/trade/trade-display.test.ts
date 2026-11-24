import assert from "node:assert/strict";
import test from "node:test";
import { compactTradeText } from "./trade-display.ts";

const asset = { symbol: "PIP", decimals: 9, quote: { coinType: "0x2::sui::SUI", symbol: "SUI", decimals: 9, iconUrl: null } };

test("display compacts both known fee units without changing exact input or unknown text", () => {
  const exact = "Curve fees 123,456.123456789 PIP and 0.000000001 SUI; 0 PIP burned";
  assert.equal(compactTradeText(exact, asset), "Curve fees 123,456 PIP and 0.000000001 SUI; 0 PIP burned");
  assert.match(exact, /123,456.123456789/);
  assert.equal(compactTradeText("0.000000001 PIP", asset), "0.000000001 PIP");
  assert.equal(compactTradeText("0.123456789 UNKNOWN", asset), "0.123456789 UNKNOWN");
  assert.equal(compactTradeText(exact, null), exact);
});
