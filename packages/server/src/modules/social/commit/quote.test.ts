import { mainnetIdentity } from "@blast/core/modules/presale/deployment/mainnet-identity.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { COMMIT_BLOCKERS, commitAvailabilityOf, commitBlockers, commitOffLine } from "@blast/core/modules/social/contracts/commit.ts";
import { commitAvailability, commitRoute, toAtoms } from "@blast/server/modules/social/commit/chain.ts";
import {
  allocationLine,
  balanceLine,
  capLabel,
  coinAmount,
  coinMoney,
  commitAmounts,
  commitPresets,
  commitPrimary,
  commitRefusal,
  commitRefusalText,
  commitTerms,
  commitToastSub,
  commitToastTitle,
  conversionLine,
  minimumLabel,
  payBalance,
  presetAmount,
  sanitizeAmount,
  saleIsOpen,
  shareLine,
  walletRoom,
  type CommitInput,
  type CommitSale,
  type CommitViewer,
} from "@blast/core/modules/social/commit/quote.ts";

/**
 * The commit panel's model (T-028 with OA-7's dialog; FEATURE-MAP §4 and R3's
 * changes). Every figure and every word of the panel is decided here, so the
 * states the Definition of Done names — insufficient balance, below the
 * minimum, above the wallet cap, an allowlisted sale the viewer is not on, a
 * sale that closed while the dialog was open, blasting off — are each one
 * assertion rather than a browser run.
 *
 * The numbers are the acceptance gate's own fixture, driven in Chrome against
 * `design/blast-feel-preview.html` (sha256 dd8cb26c…bd5ed): Meridian, open,
 * minimum $10, wallet cap $25,000, raised $184,221 of $250,000, price
 * $0.000556 per MRDN; the viewer holds $860 USDC and 412.38 SUI at $3.42.
 */

const SUI_USD = 3.42;

const MERIDIAN: CommitSale = Object.freeze({
  presaleId: `0x${"ab".repeat(32)}`,
  name: "Meridian",
  symbol: "MRDN",
  lifecycle: "open",
  endMs: 1_791_190_037_720,
  quoteCoin: "USDC",
  minCommitment: 10,
  walletCap: 25_000,
  allowlisted: false,
  raised: 184_221,
  target: 250_000,
  presalePrice: 0.000_555_555_6,
});

const KAI: CommitViewer = Object.freeze({ usdc: 860, sui: 412.38, suiUsd: SUI_USD, committed: 0, allowlist: null });

const NOW = MERIDIAN.endMs - 6 * 3_600_000;

function panel(overrides: Partial<CommitInput> = {}): CommitInput {
  return {
    sale: MERIDIAN,
    viewer: KAI,
    payWith: "USDC",
    typed: "50",
    why: "",
    whyError: null,
    blockers: [],
    nowMs: NOW,
    ...overrides,
  };
}

test("T-028: the default panel is the gate's, down to the button's words", () => {
  const input = panel();
  assert.deepEqual(commitAmounts(input), { typed: 50, usd: 50, pay: 50, quote: 50 });
  assert.equal(conversionLine(input), "Paid in USDC");
  assert.equal(balanceLine(input), "Balance $860.00");
  assert.deepEqual(
    commitPresets(input).map((preset) => [preset.label, preset.value, preset.ariaLabel, preset.pressed]),
    [
      ["$50", "50", null, true],
      ["$100", "100", null, false],
      ["$500", "500", null, false],
      ["Max", "Max", null, false],
    ],
  );
  const terms = commitTerms(MERIDIAN, 50);
  assert.equal(terms.tokens, 90_000);
  assert.equal(allocationLine(terms), "Under target · you get 100%");
  assert.equal(shareLine(terms), "0.02%");
  assert.deepEqual(commitPrimary(input), { label: "Blast $50", disabled: false, action: "commit" });
  assert.equal(commitRefusal(input), null);
});

test("T-028: paying in SUI takes SUI as the input unit, with the R3 ladder, foot line and button", () => {
  // The gate prefills the same commitment re-expressed: 50 / 3.42 = 14.62 SUI.
  const input = panel({ payWith: "SUI", typed: "14.62" });
  assert.equal(commitAmounts(input).usd, 50.0);
  assert.equal(conversionLine(input), "≈ $50.00, swapped to USDC for you");
  assert.equal(balanceLine(input), "Balance 412.38 SUI");
  assert.deepEqual(
    commitPresets(input).map((preset) => [preset.label, preset.ariaLabel]),
    [
      ["10", "10 SUI"],
      ["25", "25 SUI"],
      ["100", "100 SUI"],
      ["Max", null],
    ],
  );
  // The SUI pay path is blocked for a USDC sale (no swap route), so the label
  // is the amount and the button is off, with the reason above it.
  assert.deepEqual(commitPrimary({ ...input, blockers: ["swap_unavailable"] }), {
    label: "Blast 14.62 SUI",
    disabled: true,
    action: "none",
  });
  // A SUI-quoted sale has no swap to make, and the same box reads SUI.
  const suiSale: CommitSale = { ...MERIDIAN, quoteCoin: "SUI", minCommitment: 25, walletCap: 7_000, raised: 50_000, target: 70_000, presalePrice: 0.000_162_5 };
  const suiPanel = panel({ sale: suiSale, payWith: "SUI", typed: "125" });
  assert.equal(conversionLine(suiPanel), "Paid in SUI");
  assert.deepEqual(commitPrimary(suiPanel), { label: "Blast 125 SUI", disabled: false, action: "commit" });
  assert.equal(commitAmounts(suiPanel).quote, 125);
  // Paying USDC into a SUI sale shows the SUI it is swapped into.
  assert.equal(conversionLine(panel({ sale: suiSale, payWith: "USDC", typed: "100" })), "≈ 29.24 SUI, swapped to SUI for you");
});

test("T-028: the minimum is named in the pay coin, rounded up so the named amount always clears it", () => {
  // In the sale's own coin it is the gate's `qm`: "$10", and cents only when there are some.
  assert.equal(minimumLabel(panel()), "$10");
  assert.equal(minimumLabel(panel({ sale: { ...MERIDIAN, minCommitment: 12.5 } })), "$12.50");
  // $10 at $3.42 is 2.9239… SUI, so the button says 2.93.
  assert.equal(minimumLabel(panel({ payWith: "SUI" })), "2.93 SUI");
  const suiSale: CommitSale = { ...MERIDIAN, quoteCoin: "SUI", minCommitment: 25 };
  assert.equal(minimumLabel(panel({ sale: suiSale, payWith: "SUI" })), "25 SUI");
  assert.equal(minimumLabel(panel({ sale: suiSale, payWith: "USDC" })), "$85.50");
  // An allowlisted sale has no published minimum.
  assert.equal(minimumLabel(panel({ sale: { ...MERIDIAN, allowlisted: true, minCommitment: null } })), null);
  // Without a SUI price the two coins cannot be converted at all.
  assert.equal(minimumLabel(panel({ payWith: "SUI", viewer: { ...KAI, suiUsd: null } })), null);
});

test("T-028-AC-2: below the minimum, over the balance and an empty box each say so and refuse", () => {
  assert.deepEqual(commitPrimary(panel({ typed: "" })), { label: "Enter an amount", disabled: true, action: "none" });
  assert.deepEqual(commitPrimary(panel({ typed: "0" })), { label: "Enter an amount", disabled: true, action: "none" });
  assert.deepEqual(commitPrimary(panel({ typed: "5" })), { label: "Minimum is $10", disabled: true, action: "none" });
  // Over the balance is an action, not a dead end: it opens Deposit.
  assert.deepEqual(commitPrimary(panel({ typed: "2000" })), { label: "Add USDC", disabled: false, action: "deposit" });
  assert.deepEqual(commitPrimary(panel({ payWith: "SUI", typed: "500" })), { label: "Add SUI", disabled: false, action: "deposit" });
  // The ticket's own example: amount 50, minimum 100, Max 500 prefills 100 and clears.
  const steep: CommitSale = { ...MERIDIAN, minCommitment: 100 };
  assert.equal(commitRefusal(panel({ sale: steep, typed: "50" })), "min");
  assert.equal(commitRefusal(panel({ sale: steep, typed: "100" })), null);
  // Max 30 with minimum 100: no amount both clears the minimum and fits.
  const poor: CommitViewer = { ...KAI, usdc: 30 };
  assert.equal(commitRefusal(panel({ sale: steep, viewer: poor, typed: "30" })), "min");
  assert.equal(commitRefusal(panel({ sale: steep, viewer: poor, typed: "100" })), "insufficient");
});

test("T-028: above the wallet cap is refused before the press, which the reference only does after it", () => {
  // The gate's own fixture cannot reach this: the cap is $25,000 and the
  // viewer holds $860, so its panel never shows the state and its
  // `commitErrorText('cap')` is only seen after Blast is pressed.
  const rich: CommitViewer = { ...KAI, usdc: 60_000 };
  assert.equal(walletRoom(MERIDIAN, rich, NOW), 25_000);
  assert.deepEqual(commitPrimary(panel({ viewer: rich, typed: "26000" })), {
    label: "The most one wallet can put in is $25,000",
    disabled: true,
    action: "none",
  });
  // What the wallet already holds counts against the cap.
  const held: CommitViewer = { ...rich, committed: 24_000 };
  assert.equal(walletRoom(MERIDIAN, held, NOW), 1_000);
  assert.equal(commitRefusal(panel({ viewer: held, typed: "1500" })), "cap");
  assert.equal(commitRefusal(panel({ viewer: held, typed: "1000" })), null);
  // An allowlisted sale's cap is the viewer's own leaf.
  const allowlisted: CommitSale = { ...MERIDIAN, allowlisted: true, minCommitment: null, walletCap: null };
  const onList: CommitViewer = { ...rich, allowlist: { on: true, cap: 2_000 } };
  assert.equal(walletRoom(allowlisted, onList, NOW), 2_000);
  assert.equal(capLabel(panel({ sale: allowlisted, viewer: onList })), "$2,000");
  assert.equal(commitRefusal(panel({ sale: allowlisted, viewer: onList, typed: "2500" })), "cap");
  // Off the list: no amount helps, and the reference has no copy for it (OA-13).
  const offList: CommitViewer = { ...rich, allowlist: { on: false, cap: null } };
  assert.deepEqual(commitPrimary(panel({ sale: allowlisted, viewer: offList, typed: "100" })), {
    label: "You’re not on the allowlist",
    disabled: true,
    action: "none",
  });
  // Until the leaf has been read, nothing is claimed about the list.
  assert.equal(commitRefusal(panel({ sale: allowlisted, viewer: { ...rich, allowlist: null }, typed: "100" })), null);
});

test("T-028: a sale that closed while the dialog was open refuses in the reference's words", () => {
  assert.ok(saleIsOpen(MERIDIAN, NOW));
  assert.ok(!saleIsOpen(MERIDIAN, MERIDIAN.endMs));
  assert.deepEqual(commitPrimary(panel({ nowMs: MERIDIAN.endMs + 1 })), {
    label: "Meridian isn’t taking commitments",
    disabled: true,
    action: "none",
  });
  for (const lifecycle of ["pending", "funded", "cancelled", "migrated", "closed"]) {
    assert.equal(commitRefusal(panel({ sale: { ...MERIDIAN, lifecycle } })), "closed", lifecycle);
  }
});

test("T-028: a why that fails disables the button, but an unaffordable amount is offered first", () => {
  assert.deepEqual(commitPrimary(panel({ whyError: "Links aren’t allowed in a why." })), {
    label: "Fix your why to continue",
    disabled: true,
    action: "none",
  });
  // The reference's own order (`!amt || under || (!!bad && !short1)`): "Add
  // USDC" is an action and wins over a correction.
  assert.deepEqual(commitPrimary(panel({ typed: "2000", whyError: "Keep it to 280 characters." })), {
    label: "Add USDC",
    disabled: false,
    action: "deposit",
  });
  // And a refusal no amount fixes wins over both.
  assert.equal(commitRefusal(panel({ typed: "2000", whyError: "x", nowMs: MERIDIAN.endMs + 1 })), "closed");
});

test("T-028: blasting off keeps the amount's label and turns the button off, with one published line", () => {
  const off = panel({ blockers: ["presale_not_deployed"] });
  assert.equal(commitRefusal(off), "blocked");
  assert.deepEqual(commitPrimary(off), { label: "Blast $50", disabled: true, action: "none" });
  assert.equal(
    commitOffLine(["presale_not_deployed"]),
    "Blasting opens once the sale contract is live on Sui mainnet. Nothing is sent until then.",
  );
  assert.equal(commitOffLine(["wallet_missing"]), "Your Blast wallet is still being set up. Try again in a moment.");
  assert.equal(commitOffLine(["swap_unavailable"]), "A swap into this sale’s coin is unavailable or the quote changed. Refresh the quote or pay with the coin it raises in.");
  // Every blocker has a line, and the most important one is named first.
  for (const blocker of COMMIT_BLOCKERS) assert.ok(commitOffLine([blocker]).length > 0, blocker);
  assert.equal(commitOffLine(["wallet_missing", "presale_not_deployed"]), commitOffLine(["presale_not_deployed"]));
});

test("T-028: a held blast is refused for exactly what the panel refuses, in one sentence", () => {
  assert.equal(commitRefusalText(panel()), null);
  assert.equal(commitRefusalText(panel({ blockers: ["presale_not_deployed"] })), commitOffLine(["presale_not_deployed"]));
  assert.equal(commitRefusalText(panel({ typed: "5" })), "Minimum is $10");
  // "Add USDC" is the panel's button; with no panel it is a reason, in R3's shared words.
  assert.equal(commitRefusalText(panel({ typed: "2000" })), "Not enough to cover it");
  const held: CommitViewer = { ...KAI, usdc: 60_000, committed: 24_500 };
  assert.equal(commitRefusalText(panel({ viewer: held, typed: "1000" })), "The most one wallet can put in is $25,000");
  assert.equal(commitRefusalText(panel({ nowMs: MERIDIAN.endMs })), "Meridian isn’t taking commitments");
  const allowlisted: CommitSale = { ...MERIDIAN, allowlisted: true, minCommitment: null, walletCap: null };
  assert.equal(commitRefusalText(panel({ sale: allowlisted, viewer: { ...KAI, allowlist: { on: false, cap: null } } })), "You’re not on the allowlist");
});

test("T-024/T-028: the blocker list is one list, and it is the same on both sides of the wire", () => {
  assert.deepEqual(commitBlockers({ deployed: false, wallet: null }), ["presale_not_deployed", "wallet_missing"]);
  assert.deepEqual(commitBlockers({ deployed: true, wallet: `0x${"1".repeat(64)}` }), []);
  assert.deepEqual(commitBlockers({ deployed: true, wallet: "0x1", payWith: "SUI", quoteCoin: "USDC" }), ["swap_unavailable"]);
  assert.deepEqual(commitBlockers({ deployed: true, wallet: "0x1", payWith: "USDC", quoteCoin: "USDC" }), []);
  assert.deepEqual(commitBlockers({ deployed: true, wallet: "0x1", allowlistUnreadable: true }), ["allowlist_unavailable"]);
  assert.deepEqual(commitAvailabilityOf([]), { available: true });
  assert.deepEqual(commitAvailabilityOf(["presale_not_deployed"]), { available: false, reasons: ["presale_not_deployed"] });
  // The server's entry point reaches the same answer from the manifest state.
  assert.deepEqual(commitAvailability({ state: { status: "unavailable", reason: "missing" }, wallet: "0x1" }), {
    available: false,
    reasons: ["presale_not_deployed"],
  });
  assert.equal(mainnetIdentity({ status: "unavailable", reason: "missing" }), null);
});

test("T-028: Max never offers more than the wallet holds, and the presets press on what is typed", () => {
  assert.equal(presetAmount("Max", panel()), 860);
  assert.equal(presetAmount("Max", panel({ payWith: "SUI" })), 412.38);
  assert.equal(presetAmount("100", panel()), 100);
  assert.equal(payBalance(panel()).coin, 860);
  assert.equal(payBalance(panel({ payWith: "SUI" })).usd, 412.38 * SUI_USD);
  const maxed = commitPresets(panel({ typed: "860" }));
  assert.deepEqual(maxed.map((preset) => preset.pressed), [false, false, false, true]);
  // An empty box presses nothing, including Max on a wallet holding nothing.
  assert.deepEqual(
    commitPresets(panel({ typed: "", viewer: { ...KAI, usdc: 0 } })).map((preset) => preset.pressed),
    [false, false, false, false],
  );
});

test("T-028: the amount box takes digits and one dot with at most two decimals", () => {
  assert.equal(sanitizeAmount("1,234"), "1234");
  assert.equal(sanitizeAmount("12.345"), "12.34");
  assert.equal(sanitizeAmount("12.3.4"), "12.34");
  assert.equal(sanitizeAmount("-5e3"), "53");
  assert.equal(sanitizeAmount("abc"), "");
  assert.equal(sanitizeAmount(".5"), ".5");
});

test("T-028-AC-3: the terms are the viewer's own, and oversubscription is shown as the reference words it", () => {
  // Under target.
  assert.equal(allocationLine(commitTerms(MERIDIAN, 50)), "Under target · you get 100%");
  // Over target: 1.3x oversubscribed gives ~77%.
  const nearly: CommitSale = { ...MERIDIAN, raised: 300_000 };
  const over = commitTerms(nearly, 25_000);
  assert.equal(allocationLine(over), "1.3× oversubscribed · you'd get ~77%");
  assert.equal(shareLine(commitTerms(MERIDIAN, 1)), "<0.01%");
  // Without a price nothing is claimed about the tokens.
  assert.equal(commitTerms({ ...MERIDIAN, presalePrice: null }, 50).tokens, null);
  // A sale with no target (nothing raised yet either) divides by nothing.
  const empty = commitTerms({ ...MERIDIAN, target: 0, raised: 0 }, 50);
  assert.deepEqual([empty.multiple, empty.fill, empty.share], [0, 1, 100]);
  assert.equal(shareLine(commitTerms({ ...MERIDIAN, target: 0, raised: 0 }, 0)), "<0.01%");
});

test("T-028: the toast is R3's, which drops the amount the title already carries", () => {
  assert.equal(commitToastTitle(500, "USDC", "Meridian"), "Blasted $500 into Meridian");
  assert.equal(commitToastTitle(12.5, "USDC", "Meridian"), "Blasted $12.50 into Meridian");
  assert.equal(commitToastTitle(14.62, "SUI", "Meridian"), "Blasted 14.62 SUI into Meridian");
  assert.equal(
    commitToastSub({ payWith: "USDC", quoteCoin: "USDC", usd: 500, quote: 500, throughName: "Mira" }),
    "Paid with USDC · through Mira’s post",
  );
  assert.equal(commitToastSub({ payWith: "USDC", quoteCoin: "USDC", usd: 500, quote: 500, throughName: null }), "Paid with USDC");
  assert.equal(
    commitToastSub({ payWith: "SUI", quoteCoin: "USDC", usd: 500, quote: 500, throughName: null }),
    "Swapped to $500.00 USDC",
  );
  assert.equal(
    commitToastSub({ payWith: "USDC", quoteCoin: "SUI", usd: 500, quote: 146.2, throughName: null }),
    "Swapped to 146.2 SUI",
  );
});

test("T-028: money and coin amounts are formatted as the reference formats them", () => {
  assert.equal(coinMoney(500, "USDC"), "$500");
  assert.equal(coinMoney(12.5, "USDC"), "$12.50");
  assert.equal(coinMoney(1_240, "USDC"), "$1,240");
  assert.equal(coinMoney(25, "SUI"), "25 SUI");
  assert.equal(coinMoney(14.619_8, "SUI"), "14.62 SUI");
  assert.equal(coinAmount(1_410.34), "1,410.34");
  assert.equal(coinAmount(25), "25");
});

test("T-026/T-028: a commitment becomes atoms in the sale's own coin, floored", () => {
  assert.equal(toAtoms(50, 6), 50_000_000n);
  assert.equal(toAtoms(14.62, 9), 14_620_000_000n);
  assert.equal(toAtoms(0.000_001, 6), 1n);
  assert.equal(toAtoms(0, 6), 0n);
  assert.equal(toAtoms(-5, 6), 0n);
  assert.equal(toAtoms(Number.NaN, 6), 0n);
  // The route a sale takes: an allowlisted sale proves its leaf.
  assert.equal(commitRoute({ allowlisted: false }), "open");
  assert.equal(commitRoute({ allowlisted: true }), "allowlisted");
});

/**
 * R3-41: a SUI-quoted sale (the dev fixture's Driftwood: 25 SUI minimum,
 * 5,000 SUI cap, 99,970 of 100,000 SUI) opens its panel in SUI — the panel's
 * pay coin starts as the sale's own (`CommitPanel`'s `useState(sale.quoteCoin)`)
 * — and every refusal, the button, the foot line and the toast read in SUI.
 * Formats are the gate's `fmt2` (`maximumFractionDigits: 2`): `25 SUI`, not
 * the ticket's `25.00 SUI` (the gate wins, OA-23; recorded in T-028).
 */
const DRIFTWOOD: CommitSale = Object.freeze({
  ...MERIDIAN,
  name: "Driftwood",
  symbol: "DRFT",
  quoteCoin: "SUI",
  quoteDecimals: 9,
  minCommitment: 25,
  walletCap: 5_000,
  raised: 99_970,
  target: 100_000,
  presalePrice: 0.000_222_222_222,
});

test("R3-41-AC-1/2/3/4: a SUI-quoted sale takes SUI: presets 10 · 25 · 100 · Max named in SUI, `Minimum is 25 SUI`, `Blast 125 SUI`, `Paid in SUI`", () => {
  const sui = (typed: string, viewer: CommitViewer = KAI) => panel({ sale: DRIFTWOOD, payWith: "SUI", typed, viewer });
  assert.deepEqual(
    commitPresets(sui("25")).map((preset) => [preset.label, preset.value, preset.ariaLabel, preset.pressed]),
    [["10", "10", "10 SUI", false], ["25", "25", "25 SUI", true], ["100", "100", "100 SUI", false], ["Max", "Max", null, false]],
  );
  assert.deepEqual(commitPrimary(sui("10")), { label: "Minimum is 25 SUI", disabled: true, action: "none" });
  assert.deepEqual(commitPrimary(sui("125")), { label: "Blast 125 SUI", disabled: false, action: "commit" });
  assert.deepEqual(commitPrimary(sui("125.5")), { label: "Blast 125.5 SUI", disabled: false, action: "commit" });
  assert.equal(conversionLine(sui("125")), "Paid in SUI");
  assert.deepEqual(commitAmounts(sui("125")), { typed: 125, usd: 427.5, pay: 125, quote: 125 });
  // The cap and the balance in SUI: 5,000 SUI per wallet, and Kai holds 412.38.
  assert.deepEqual(commitPrimary(sui("400", { ...KAI, sui: 10_000 })), { label: "Blast 400 SUI", disabled: false, action: "commit" });
  assert.deepEqual(commitPrimary(sui("5001", { ...KAI, sui: 10_000 })), { label: "The most one wallet can put in is 5,000 SUI", disabled: true, action: "none" });
  assert.deepEqual(commitPrimary(sui("500")), { label: "Add SUI", disabled: false, action: "deposit" });
  // Held already counts against the cap, in SUI.
  assert.equal(walletRoom(DRIFTWOOD, { ...KAI, committed: 4_900 }, NOW), 100);
  // The held gesture refuses in the same words.
  assert.equal(commitRefusalText(sui("10")), "Minimum is 25 SUI");
  assert.equal(commitRefusalText(sui("500")), "Not enough to cover it");
});

test("R3-41: a SUI-quoted sale needs no SUI price to commit in SUI — the minimum and the button stand; only the dollar figure is unknown", () => {
  const unpriced = { ...KAI, suiUsd: null };
  const input = panel({ sale: DRIFTWOOD, payWith: "SUI", typed: "125", viewer: unpriced });
  assert.equal(minimumLabel(input), "25 SUI");
  assert.deepEqual(commitPrimary(input), { label: "Blast 125 SUI", disabled: false, action: "commit" });
  assert.deepEqual(commitAmounts(input), { typed: 125, usd: 0, pay: 125, quote: 125 });
  assert.deepEqual(commitPrimary({ ...input, typed: "24.99" }), { label: "Minimum is 25 SUI", disabled: true, action: "none" });
});

test("R3-41-AC-5: the toast says which coin paid: `Paid with SUI · through Mira’s post`, or what it was swapped to", () => {
  assert.equal(commitToastTitle(125, "SUI", "Driftwood"), "Blasted 125 SUI into Driftwood");
  assert.equal(commitToastSub({ payWith: "SUI", quoteCoin: "SUI", usd: 427.5, quote: 125, throughName: "Mira" }), "Paid with SUI · through Mira’s post");
  assert.equal(commitToastSub({ payWith: "SUI", quoteCoin: "SUI", usd: 0, quote: 125, throughName: null }), "Paid with SUI");
});

test("R3-41-AC-8: the box takes digits and one dot with at most two decimals, in both units; the atoms it sends are the view's decimals", () => {
  for (const raw of ["125.555", "1,25.5", "12a5.5"]) assert.match(sanitizeAmount(raw), /^\d*(\.\d{0,2})?$/);
  assert.equal(sanitizeAmount("125.555"), "125.55");
  assert.equal(toAtoms(Number(sanitizeAmount("125.55")), DRIFTWOOD.quoteDecimals!), 125_550_000_000n);
  assert.equal(toAtoms(Number(sanitizeAmount("10.01")), 6), 10_010_000n);
});

test("an unpriced TSUI commitment keeps quote units, precision and balances without borrowing SUI's USD price", () => {
  const sale = { ...MERIDIAN, quoteCoin: "TSUI", quoteDecimals: 9 };
  const viewer = { ...KAI, quoteCoin: "TSUI", quoteBalance: 25.000000001, quoteUsd: null };
  const input = panel({ sale, viewer, payWith: "TSUI", typed: "25.000000001" });
  assert.deepEqual(commitAmounts(input), { typed: 25.000000001, quote: 25.000000001, pay: 25.000000001, usd: 0 });
  assert.equal(commitPrimary(input).label, "Blast 25.000000001 TSUI");
  assert.equal(balanceLine(input), "Balance 25.000000001 TSUI");
  assert.equal(coinMoney(0.000000001, "TSUI"), "0.000000001 TSUI");
  assert.equal(sanitizeAmount("25.0000000019", 9), "25.000000001");
  assert.equal(commitRefusal({ ...input, typed: "26" }), "insufficient");
});

test("the anyone route starts at its exact boundary and ends at close", () => {
  const sale = { allowlisted: true, publicFromMs: 96n, endMs: 120n };
  assert.equal(commitRoute(sale, 95n), "allowlisted");
  assert.equal(commitRoute(sale, 96n), "uncapped");
  assert.equal(commitRoute(sale, 119n), "uncapped");
  assert.equal(commitRoute(sale, 120n), "allowlisted");
  assert.equal(commitRoute({ ...sale, publicFromMs: null }, 100n), "allowlisted");
});

test("a new day-five buyer can fill the last two MIST exactly", () => {
  const sale = { ...DRIFTWOOD, publicBuy: true, hardCapped: true, quoteDecimals: 9,
    target: 60_000, raised: 59_999.999999998, remainingAtoms: "2", minCommitment: 1.083560581 };
  const input = panel({ sale, viewer: { ...KAI, committed: 0 }, payWith: "SUI", typed: "0.000000002" });
  assert.equal(commitRefusal(input), null);
  assert.equal(commitRefusal({ ...input, typed: "0.000000001" }), "min");
});
