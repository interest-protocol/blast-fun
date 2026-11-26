import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  actionDisabled,
  actionLabel,
  actionReason,
  amountAtoms,
  bridgeAction,
  bridgeChains,
  CHAINS,
  DESTINATIONS,
  exceedsBalance,
  maxField,
  quoteErrorText,
  quoteRows,
  transferState,
  usdBand,
  type ActionInput,
} from "./bridge-model.ts";

const [ETH, USDC] = CHAINS.base.tokens;

test("only chains with an RPC are offered, in picker order", () => {
  assert.deepEqual(bridgeChains({ rpcs: { solana: "https://s", base: "https://b" } }), ["base", "solana"]);
  assert.deepEqual(bridgeChains({ rpcs: { arbitrum: "https://a", ethereum: "https://e", base: "https://b", solana: "https://s" } }), ["base", "ethereum", "arbitrum", "solana"]);
});

test("typed amounts become atoms; Max and the balance check keep gas back for native tokens", () => {
  assert.equal(amountAtoms("20", USDC), 20_000_000n);
  assert.equal(amountAtoms("1,000.5", USDC), 1_000_500_000n);
  assert.equal(amountAtoms("0.0000001", USDC), null, "below one atom");
  assert.equal(amountAtoms("", ETH), null);
  assert.equal(amountAtoms("abc", ETH), null);
  assert.equal(amountAtoms("0.01", ETH), 10_000_000_000_000_000n);

  assert.equal(maxField(5_000_000n, USDC), "5");
  assert.equal(maxField(1_000_000_000_000_000n, ETH), "0.00098", "0.001 ETH less the 0.00002 reserve");
  assert.equal(maxField(10_000_000_000_000n, ETH), "0", "balance under the reserve");
  assert.equal(exceedsBalance(5_000_000n, 5_000_000n, USDC), false);
  assert.equal(exceedsBalance(980_000_000_000_000n, 1_000_000_000_000_000n, ETH), false);
  assert.equal(exceedsBalance(980_000_000_000_001n, 1_000_000_000_000_000n, ETH), true);
});

test("quote rows: tiny fees, missing USD and time", () => {
  const rows = quoteRows({ expectedAmountOut: 7.071843, minReceived: 7.00474, clientRelayerFeeSuccess: 0.004, etaSeconds: 0 }, CHAINS.solana.tokens[0], DESTINATIONS[1]!);
  assert.deepEqual(rows, { amount: "7.07184", minimum: "7.00474\u00a0USDC", fee: "< $0.01", eta: "About 1\u00a0s" });
  assert.equal(quoteRows({ expectedAmountOut: 1, minReceived: 1, clientRelayerFeeSuccess: null, etaSeconds: 150 }, ETH, DESTINATIONS[0]!).eta, "About 3\u00a0min");
});

test("Mayan's explorer status maps to the row state", () => {
  assert.equal(transferState("COMPLETED"), "done");
  assert.equal(transferState("REFUNDED"), "refunded");
  assert.equal(transferState("INPROGRESS"), "pending");
  assert.equal(transferState(undefined), "pending");
});

test("quote errors read as plain sentences with Mayan's limits", () => {
  const base = CHAINS.base;
  assert.equal(quoteErrorText({ code: 9999, message: "Swap SDK is outdated!" }, base, USDC), "Bridging is paused. You can still deposit on Sui. Code: bridge_paused.");
  assert.equal(quoteErrorText({ code: "AMOUNT_TOO_SMALL", data: { minAmountIn: 0.05 } }, base, USDC), "The smallest amount is 0.05\u00a0USDC. Code: bridge_amount_too_small.");
  assert.equal(quoteErrorText({ code: "AMOUNT_TOO_LARGE", data: { maxAmountIn: 300 } }, base, USDC), "The largest amount is 300\u00a0USDC. Code: bridge_amount_too_large.");
  assert.equal(quoteErrorText({ code: "ROUTE_NOT_FOUND" }, base, ETH), "No route from Base ETH to Sui right now. Code: bridge_no_route.");
  assert.equal(quoteErrorText(new TypeError("Failed to fetch"), base, ETH), "Couldn’t get a price. Code: bridge_quote_failed.");
  assert.equal(quoteErrorText(null, base, ETH), "Couldn’t get a price. Code: bridge_quote_failed.");
});

const READY: ActionInput = {
  paused: false,
  signedIn: true,
  blastAddress: `0x${"ab".repeat(32)}`,
  sourceConnected: true,
  wrongChain: false,
  atoms: 1n,
  insufficient: false,
  quoting: false,
  quoteFailed: false,
  hasQuote: true,
  busy: false,
  needsApproval: false,
  rateChanged: false,
};

test("the one button names the next step, in order", () => {
  const cases: [Partial<ActionInput>, string, string | null, boolean][] = [
    [{ paused: true, signedIn: false }, "Bridge", null, true],
    [{ signedIn: false, sourceConnected: false }, "Sign in", null, false],
    [{ blastAddress: null }, "Bridge", "Loading your account.", true],
    [{ sourceConnected: false, atoms: null }, "Connect wallet", null, false],
    [{ wrongChain: true }, "Switch to Base", null, false],
    [{ atoms: null }, "Bridge", "Enter an amount.", true],
    [{ insufficient: true }, "Bridge", "Not enough USDC for this amount.", true],
    [{ busy: true, needsApproval: true }, "Bridge", null, true],
    [{ quoting: true }, "Bridge", null, true],
    [{ hasQuote: false }, "Bridge", null, true],
    [{ hasQuote: false, quoteFailed: true }, "Try again", null, false],
    [{ quoteFailed: true, quoting: true }, "Bridge", null, true],
    [{ needsApproval: true }, "Approve USDC", null, false],
    [{ rateChanged: true }, "Bridge at new rate", null, false],
    [{}, "Bridge", null, false],
  ];
  for (const [change, label, reason, disabled] of cases) {
    const action = bridgeAction({ ...READY, ...change });
    assert.equal(actionLabel(action, CHAINS.base, USDC), label, JSON.stringify(change));
    assert.equal(actionReason(action, USDC), reason, JSON.stringify(change));
    assert.equal(actionDisabled(action), disabled, label);
  }
});

test("every chain and coin logo is a file the app serves", () => {
  const logos = [...Object.values(CHAINS).flatMap((chain) => [chain.logo, ...chain.tokens.map((token) => token.logo)]), ...DESTINATIONS.map((token) => token.logo)];
  for (const logo of new Set(logos)) assert.ok(existsSync(new URL(`../../../../public${logo}`, import.meta.url)), logo);
});

test("the analytics band is coarse and marks amounts near the BLINK cap", () => {
  assert.deepEqual([undefined, 2, 20, 120, 299].map(usdBand), ["unknown", "<10", "10-100", "100-250", "250+"]);
});
