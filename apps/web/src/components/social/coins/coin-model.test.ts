import { atomsToField, fmtLive, parseAtoms } from "#web/components/social/trade/trade-ticket.ts";
import { CORE_COINS, coinPriority } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { compareHoldings } from "./coin-model";
import assert from "node:assert/strict";
import test from "node:test";

import { shortAddress } from "@blast/core/lib/format.ts";

import { ALL_COINS_KEY, coinAmt, coinCount, coinSub, coinsValue, SCREEN_LABEL, coinPriceLine, coinValue, coinView, firstScreen, maxWithdrawAtoms, numIn, parseCoinScreen, walletCoinViews, WITHDRAW_BAD_ADDRESS, WITHDRAW_HINT, WITHDRAW_HINT_INITIAL, WITHDRAW_OWN_ADDRESS, withdrawCheck } from "./coin-model";
import { FIXTURE_WALLET_ADDRESS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

/** Social UI-14: the coins sheet's formats and rules, against the live design's sample wallet. */

const [USDC, SUI, KSTL, LUMN] = FIXTURE_COINS as [typeof FIXTURE_COINS[number], typeof FIXTURE_COINS[number], typeof FIXTURE_COINS[number], typeof FIXTURE_COINS[number]];
const A3 = `0x${"a3".repeat(32)}`;
const check = (input: Partial<Parameters<typeof withdrawCheck>[0]>) =>
  withdrawCheck({ coin: USDC, amountText: "", to: "", touched: false, fee: "sponsored", own: FIXTURE_WALLET_ADDRESS, suiAtoms: SUI.atoms, ...input });

test("OAuth navigation restores only recognized screens and discards account data", () => {
  assert.deepEqual(parseCoinScreen({ kind: "trade", key: "usdc", out: "sui", focus: "sui", balance: "900" }), { kind: "trade", key: "usdc", out: "sui", focus: "sui" });
  assert.deepEqual(parseCoinScreen({ kind: "pick", mode: "deposit" }), { kind: "dep" });
  assert.deepEqual(parseCoinScreen({ kind: "dep", key: "usdc" }), { kind: "dep" });
  assert.deepEqual(parseCoinScreen({ kind: "fund" }), { kind: "fund" });
  assert.deepEqual(parseCoinScreen({ kind: "pickt", side: "out" }), { kind: "pickt", side: "out" });
  assert.deepEqual(parseCoinScreen({ kind: "all" }), { kind: "all" });
  assert.deepEqual(parseCoinScreen({ kind: "wd", key: "sui" }), { kind: "wd", key: "sui" });
  for (const value of [null, "trade", { kind: "send", key: "sui" }, { kind: "pick", mode: "send" }, { kind: "pickt", side: "sell" }, { kind: "trade", key: "" }, { kind: "trade", key: "usdc", out: 1 }]) assert.equal(parseCoinScreen(value), null);
});

test("the shell opens the address for deposits and a coin picker for withdrawals", () => {
  assert.deepEqual(firstScreen("deposit", null), { kind: "dep" });
  assert.deepEqual(firstScreen("withdraw", null), { kind: "pick", mode: "withdraw" });
  assert.deepEqual(firstScreen("coin", "kstl"), { kind: "coin", key: "kstl" });
  assert.deepEqual(firstScreen("coin", null), { kind: "all" });
  // R3-10: "All coins" has no shell action of its own, so one reserved key opens it (`coin-model.ts`).
  assert.deepEqual(firstScreen("coin", ALL_COINS_KEY), { kind: "all" });
  assert.equal(SCREEN_LABEL.all, "Your coins");
});

test("R3-10: a coin list's sub-line, total and count", () => {
  // The ticker is left off when the name is already the ticker.
  assert.deepEqual(FIXTURE_COINS.map((coin) => coinSub(coin, coin.amount)), ["860", "412.38", "600,000\u00a0KSTL", "100,000\u00a0LUMN"]);
  assert.equal(coinsValue(FIXTURE_COINS), 3660.34);
  // One coin without a fresh price makes the total unknown rather than smaller.
  assert.equal(coinsValue([...FIXTURE_COINS, { value: null }]), null);
  assert.equal(coinsValue([]), 0);
  assert.equal(coinCount(0), "0 coins");
  assert.equal(coinCount(1), "1 coin");
  assert.equal(coinCount(12), "12 coins");
});

test("wallet coins: USDC and SUI by type, a sale coin by its presale; exact amounts; the design's row strings", () => {
  assert.deepEqual(FIXTURE_COINS.map((coin) => [coin.key, coin.round, coinAmt(coin, coin.amount), coinValue(coin)]), [
    ["usdc", true, "860\u00a0USDC", "$860"],
    ["sui", true, "412.38\u00a0SUI", "$1,410"],
    ["kstl", false, "600,000\u00a0KSTL", "$1,260"],
    ["lumn", false, "100,000\u00a0LUMN", "$130"],
  ]);
  const unpriced = coinView({ coin_type: SUI_COIN_TYPE, symbol: "SUI", name: "SUI", decimals: 9, atoms: "1", usd_price: null, value_usd: null, icon_url: null, presale: null });
  assert.equal(coinValue(unpriced), "—");
  assert.equal(unpriced.amount, 1e-9);
  assert.deepEqual(walletCoinViews(null), []);
  assert.deepEqual(walletCoinViews({ address: null, signer: "privy", fee: "sponsored", coins: null, as_of_ms: 0 }), []);
  const unknown = coinView({ coin_type: `0x${"9".repeat(64)}::coin::TOKEN`, symbol: "TOKEN", name: "TOKEN", decimals: null, atoms: "123", usd_price: null, value_usd: null, icon_url: null, presale: null });
  assert.equal(unknown.amount, 123);
  assert.equal(unknown.metadataAvailable, false);
  assert.equal(unknown.name, "TOKEN (base units)");
});

test("R3-33-AC-10: price lines drop the venue — USDC is always $1, SUI its price, a sale coin its multiple; what each says without data", () => {
  assert.deepEqual(coinPriceLine(USDC), { kind: "text", text: "Always worth $1.00" });
  assert.deepEqual(coinPriceLine(SUI), { kind: "text", text: "$3.42" });
  assert.deepEqual(coinPriceLine(SUI, 2.41), { kind: "change", before: "$3.42 · ", strong: "+2.41%", tone: "up", after: " today" });
  // FEATURE-MAP-R3 §14.2: `$0.42 · 4.2× since the presale` — no `· trades on Cetus`.
  assert.deepEqual(coinPriceLine(KSTL), { kind: "change", before: "$0.0021 · ", strong: "4.2×", tone: "up", after: " since the presale" });
  const lumn = coinPriceLine(LUMN);
  assert.equal(lumn.kind === "change" ? lumn.tone : null, "down");
  const presale = (trading: boolean, price: string | null, multiple: string | null) =>
    coinPriceLine(coinView({ coin_type: `0x${"5".repeat(64)}::c::C`, symbol: "C", name: "C", decimals: 9, atoms: "1", usd_price: price, value_usd: null, icon_url: null, presale: { presale_id: "p", venue: "bluefin", trading, multiple } }));
  assert.deepEqual(presale(false, null, null), { kind: "text", text: "Not trading yet" });
  assert.deepEqual(presale(true, null, null), { kind: "text", text: "No price right now" });
  assert.deepEqual(presale(true, "0.5", null), { kind: "text", text: "$0.5000" });
  for (const coin of [USDC, SUI, KSTL, LUMN]) {
    const line = coinPriceLine(coin);
    assert.doesNotMatch(line.kind === "text" ? line.text : `${line.before}${line.strong}${line.after}`, /trades on|Cetus|Bluefin/);
  }
});

test("typed amounts: grouped as typed, at most six places, parsed to exact atoms", () => {
  assert.equal(fmtLive("100000"), "100,000");
  assert.equal(fmtLive("1,000.1234567"), "1,000.123456");
  assert.equal(fmtLive(".5"), "0.5");
  assert.equal(fmtLive("12abc"), "12");
  assert.equal(fmtLive("1.5", 0), "1");
  assert.equal(numIn("1,000.5"), 1000.5);
  assert.equal(numIn(""), 0);
  assert.equal(parseAtoms("100", 6), 100_000_000n);
  assert.equal(parseAtoms("1,000.123456", 6), 1_000_123_456n);
  assert.equal(parseAtoms("0.1234567", 6), 123_456n, "extra places are dropped, never rounded up");
  assert.equal(parseAtoms("412.38", 9), 412_380_000_000n);
  assert.equal(parseAtoms("", 6), null);
  assert.equal(parseAtoms(".", 6), null);
  assert.equal(parseAtoms("1e5", 6), null);
  assert.equal(atomsToField(860_000_000n, 6), "860");
  assert.equal(atomsToField(412_380_000_000n, 9), "412.38");
  assert.equal(atomsToField(1_234_567_891n, 9), "1.234567", "the field rounds down at six places");
});

test("withdraw: the design's button and address lines in order; OA-13 own-address and fee rules", () => {
  assert.deepEqual([check({}).label, check({}).message, check({}).value, check({}).ready], ["Enter an amount", WITHDRAW_HINT_INITIAL, "USDC", false]);
  assert.equal(check({ amountText: "1,000", touched: true }).label, "More than you have");
  assert.equal(check({ amountText: "100", touched: true }).label, "Enter an address");
  const bad = check({ amountText: "100", to: "0x12", touched: true });
  assert.deepEqual([bad.label, bad.message, bad.bad], ["Check the address", WITHDRAW_BAD_ADDRESS, true]);
  const ok = check({ amountText: "100", to: A3, touched: true });
  assert.deepEqual([ok.label, ok.message, ok.bad, ok.ready, ok.atoms], ["Withdraw 100\u00a0USDC", WITHDRAW_HINT, false, true, 100_000_000n]);
  assert.equal(check({ amountText: "100", to: ` ${A3.toUpperCase().replace("0X", "0x")} `, touched: true }).ready, true, "either case, trimmed");
  const own = check({ amountText: "100", to: FIXTURE_WALLET_ADDRESS, touched: true });
  assert.deepEqual([own.label, own.message, own.ready], ["Check the address", WITHDRAW_OWN_ADDRESS, false]);
  // A sale coin shows its dollar value and its symbol.
  const kstl = check({ coin: KSTL, amountText: "1,000", to: A3, touched: true });
  assert.deepEqual([kstl.value, kstl.label], ["≈ $2.10", "Withdraw 1,000\u00a0KSTL"]);
  // A wallet that pays its own fee needs a little SUI, and keeps some back from a SUI withdrawal.
  assert.equal(check({ coin: KSTL, amountText: "100", to: A3, fee: "wallet", suiAtoms: 1_000_000n }).label, "Add SUI for the network fee");
  assert.equal(maxWithdrawAtoms(SUI, "sponsored"), SUI.atoms);
  assert.equal(maxWithdrawAtoms(SUI, "wallet"), SUI.atoms - 20_000_000n);
  assert.equal(maxWithdrawAtoms(USDC, "wallet"), USDC.atoms);
  assert.equal(check({ coin: SUI, amountText: "412.38", to: A3, fee: "wallet" }).label, "More than you have");
});

test("only native USDC withdraws without SUI, with a 0.01 USDC minimum", () => {
  for (const fee of ["wallet", "sponsored"] as const) {
    for (const amountText of ["0.01", "100", "860"]) {
      assert.equal(check({ amountText, to: A3, fee, suiAtoms: 0n }).ready, true);
    }
    const small = check({ amountText: "0.009999", to: A3, fee, suiAtoms: 0n });
    assert.equal(small.ready, false);
    assert.equal(small.label, "Minimum withdrawal is 0.01 USDC");
    assert.equal(check({ amountText: "0", to: A3, fee, suiAtoms: 0n }).label, "Enter an amount");
  }
  const spoof = { ...USDC, coinType: KSTL.coinType };
  for (const coin of [SUI, KSTL, spoof]) {
    assert.equal(check({ coin, amountText: "1", to: A3, fee: "wallet", suiAtoms: 0n }).ready, false);
  }
});

test("the toast uses a short address", () => {
  assert.equal(shortAddress(A3), "0xa3a3…a3a3");
  assert.equal(USDC.coinType, USDC_COIN_TYPE);
});


test("coin lists sort all holdings by USD value regardless of preferred identity", () => {
  const preferred = ["SUI", "USDC", "USDsui"].map((symbol, index) => ({
    ...SUI, coinType: CORE_COINS.find(coin => coin.symbol === symbol)!.coinType,
    symbol, value: index === 0 ? null : index,
  }));
  const richCore = { ...SUI, coinType: CORE_COINS.find(coin => coin.symbol === "WAL")!.coinType, symbol: "WAL", value: 999999 };
  const copycat = { ...KSTL, symbol: "SUI", value: 1000000 };
  assert.deepEqual([copycat, richCore, ...preferred.toReversed()].sort(compareHoldings).map(coin => coin.coinType), [copycat, richCore, preferred[2]!, preferred[1]!, preferred[0]!].map(coin => coin.coinType));
  assert.equal(coinPriority("0x2::sui::SUI"), 0);
  assert.ok(coinPriority("0x2::sui::sui") > coinPriority(richCore.coinType));
});

test("equal USD values use preferred identity, then core status, then coin type", () => {
  const identities = ["SUI", "USDC", "USDsui", "WAL"].map(symbol => ({ ...SUI, coinType: CORE_COINS.find(coin => coin.symbol === symbol)!.coinType }));
  const other = [{ ...SUI, coinType: "0x0::coin::A" }, { ...SUI, coinType: "0x0::coin::B" }];
  for (const value of [10, 0, null]) {
    const expected = [...identities, ...other].map(coin => ({ ...coin, value }));
    assert.deepEqual(expected.toReversed().sort(compareHoldings), expected);
  }
});

test("held ecosystem coins retain their verified units when indexed decimals are unavailable", () => {
  for (const canonical of CORE_COINS) {
    const coin = coinView({ coin_type: canonical.coinType, symbol: canonical.symbol, name: canonical.symbol, decimals: null, atoms: (10n ** BigInt(canonical.decimals)).toString(), usd_price: null, value_usd: null, icon_url: null, presale: null });
    assert.equal(coin.metadataAvailable, true);
    assert.equal(coin.amount, 1);
    assert.equal(coin.name, canonical.name);
  }
});

test("a curated coin shows its curated symbol with its curated name", () => {
  const hashi = coinView({ coin_type: "0xd30fb3f8914efdbeb7b8e85fae1d65dc584b44a1281f66737b92bb9f03a59d06::btc::BTC", symbol: "hBTC", name: "BTC", decimals: 8, atoms: "100000000", usd_price: null, value_usd: null, icon_url: null, presale: null });
  assert.deepEqual([hashi.symbol, hashi.name], ["hashiBTC", "Hashi BTC"]);
});
