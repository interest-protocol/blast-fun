import { SELL_PRESETS, selectedSellPreset, sellPresetAmount, tokenAmountAtoms } from "#web/components/social/trade/trade-ticket.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { amountInAtoms, type TradeFacts } from "./trade-model";
import { DEFAULT_TRADE_PRESETS, readTradePresets, isTradePresetSelected, tradePresetDraft, validateTradePresets } from "./trade-presets";

const facts: TradeFacts = { signedIn: true, symbol: "TEST", coinType: "0x2::test::TEST", decimals: 9, price: null, usdc: 1_000_000_000n, usdcDecimals: 6, held: 1234567890123456789n, heldHint: true };

test("preset preferences reject corrupt, incomplete, zero, negative, nonfinite and out-of-range values", () => {
  assert.equal(readTradePresets("broken"), DEFAULT_TRADE_PRESETS);
  for (const value of [null, {}, { buy: ["1"], sell: ["25", "50", "75", "100"] }, ...["0", "-1", "Infinity", "1e3", "1.234", "100.01"].map(value => ({ ...DEFAULT_TRADE_PRESETS, sell: [value, "50", "75", "100"] }))]) {
    assert.equal(validateTradePresets(value), false);
    assert.equal(readTradePresets(JSON.stringify(value)), DEFAULT_TRADE_PRESETS);
  }
  const custom = { buy: ["10.25", "20", "30", "max"], sell: ["0.01", "12.34", "80", "100"] };
  assert.deepEqual(readTradePresets(JSON.stringify(custom)), custom);
});

test("custom percentages floor exact wallet atoms and never depend on price or floating-point balances", () => {
  for (const [value, bps] of [["0.01", 1n], ["0.1", 10n], ["12.3", 1230n], ["12.34", 1234n], ["75", 7500n], ["100", 10000n]] as const) {
    const draft = tradePresetDraft("sell", value, facts)!;
    assert.equal(amountInAtoms(draft, facts), facts.held! * bps / 10000n);
    assert.equal(draft.unit, "token");
  }
  assert.equal(tradePresetDraft("sell", "75", { ...facts, held: null }), null);
  assert.equal(tradePresetDraft("sell", "75", { ...facts, held: 0n }), null);
  assert.equal(tradePresetDraft("sell", "75", { ...facts, decimals: null }), null);
  assert.equal(amountInAtoms(tradePresetDraft("sell", "0.01", { ...facts, held: 1n })!, facts), 0n);
  assert.equal(amountInAtoms(tradePresetDraft("buy", "10.25", facts)!, facts), 10250000n);
  assert.equal(amountInAtoms(tradePresetDraft("buy", "max", facts)!, facts), facts.usdc);
});

test("every sell percentage retains selected atoms when balances change and clears stale selection feedback", () => {
  for (const percent of ["25", "50", "75", "100", "12.34"]) {
    const draft = tradePresetDraft("sell", percent, facts)!;
    const changed = { ...facts, held: facts.held! * 2n };
    assert.equal(amountInAtoms(draft, changed), amountInAtoms(draft, facts));
    assert.equal(isTradePresetSelected(draft, percent, facts), true);
    assert.equal(isTradePresetSelected(draft, percent, changed), false);
  }
});

test("both tickets use exact 25/50/75/Max amounts, including dust, and Max follows the live balance", () => {
  assert.deepEqual(DEFAULT_TRADE_PRESETS.sell, ["25", "50", "75", "max"]);
  for (const held of [1n, 3n, 101n, 1234567890123456789n]) {
    const coin = { atoms: held, decimals: 9 };
    const wallet = { ...facts, held, price: { n: 999999999n, scale: 3 } };
    for (const [value] of SELL_PRESETS) {
      const amount = sellPresetAmount(value, coin);
      const draft = tradePresetDraft("sell", value, wallet)!;
      const expected = value === "max" ? held : held * BigInt(value) / 100n;
      assert.equal(tokenAmountAtoms(amount, coin), expected);
      assert.equal(amountInAtoms(draft, wallet), expected);
      assert.equal(amountInAtoms(draft, { ...wallet, price: { n: 1n, scale: 9 } }), expected);
      assert.equal(selectedSellPreset(amount, coin), value === "max" || expected > 0n ? value : null);
      if (value === "max") {
        const updated = { ...wallet, held: held + 7n };
        assert.equal(tokenAmountAtoms(amount, { ...coin, atoms: updated.held }), updated.held);
        assert.equal(amountInAtoms(draft, updated), updated.held);
        assert.equal(isTradePresetSelected(draft, "max", updated), true);
      }
    }
  }
});
