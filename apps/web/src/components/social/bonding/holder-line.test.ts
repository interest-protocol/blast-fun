import assert from "node:assert/strict";
import { test } from "node:test";

import { holderLine } from "./holder-line.ts";

// 1,000,000 coins in circulation, 6 decimals; the holder has 10,000 of them (1%).
const SUPPLY = 1_000_000_000_000n;
const HELD = { basis_usd: "120.00", basis_complete: true, pnl_usd: null, pnl_multiple: null, balance: "10000000000" } as const;

test("a holder reads the market cap they bought in at and the P&L at today's", () => {
  // Paid $120 for 1% of the supply: in at $12K. At $84K the 1% is worth $840.
  assert.deepEqual(holderLine(HELD, SUPPLY, "84000"), { entry: "$12K", pnl: "+$720", percent: "+600%", tone: "up" });
  assert.deepEqual(holderLine(HELD, SUPPLY, "6000"), { entry: "$12K", pnl: "−$60", percent: "−50%", tone: "down" });
  assert.equal(holderLine(HELD, SUPPLY, "12000")?.tone, "flat");
});

test("a non-holder, an incomplete cost basis or no market cap shows nothing", () => {
  assert.equal(holderLine(null, SUPPLY, "84000"), null);
  assert.equal(holderLine({ ...HELD, basis_complete: false }, SUPPLY, "84000"), null);
  assert.equal(holderLine({ ...HELD, basis_usd: null }, SUPPLY, "84000"), null);
  assert.equal(holderLine(HELD, SUPPLY, null), null);
  assert.equal(holderLine(HELD, 0n, "84000"), null);
});
