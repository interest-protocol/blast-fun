import assert from "node:assert/strict";
import test from "node:test";

import { commitAmounts, commitRefusal } from "@blast/core/modules/social/commit/quote.ts";
import type { SocialWallet } from "@blast/core/modules/social/contracts/coins.ts";
import type { FeedItem } from "@blast/core/modules/social/contracts/items.ts";

import { isCommitSaleRead } from "./commit-client";
import { HOLD_COIN_NO_PRICE, quickInput } from "./commit-input";
import { fundedPaymentInput } from "./commit-payment";
import {
  COMMIT_COIN_DECIMALS,
  COMMIT_COIN_TYPES,
  allowlistLeafOf,
  commitDialogLabel,
  commitFactsAt,
  commitSaleOf,
  commitViewerOf,
  decimal,
  quoteCoinOf,
  saleDialogLine,
  saleFacts,
  saleFooterLinkStyle,
  sourceThroughName,
  viaEntryOf,
  walletCoin,
  type CommitSaleRead,
} from "./commit-view";

/**
 * The dialogs' view model (FEATURE-MAP §4 and §11). The reads give USD; the
 * panel works in the sale's own quote coin; this is the one place that
 * converts, so a SUI-quoted sale cannot quietly be quoted in dollars.
 */

const PRESALE = `0x${"ab".repeat(32)}`;
const START = 1_791_000_000_000;
const MONTH = 30 * 24 * 60 * 60 * 1_000;

function sale(overrides: Partial<CommitSaleRead["presale"]> = {}, rest: Partial<Omit<CommitSaleRead, "presale">> = {}): CommitSaleRead {
  return {
    presale: {
      presale_id: PRESALE,
      name: "Meridian",
      symbol: "MRDN",
      icon_url: "https://i/mrdn.png",
      phase: "open",
      venue: "cetus",
      start_ms: START,
      end_ms: START + 86_400_000,
      target_usd: "250000.00",
      raised_usd: "184221.00",
      fill_bps: 7_368,
      participants: 1_012,
      interested: 1_840,
      multiple: null,
      quote_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", quote_symbol: "USDC",
      quote_decimals: 6,
      target_atoms: "250000000000",
      raised_atoms: "184221000000",
      sale_token: `0x${"5a".repeat(32)}::mrdn::MRDN`,
      sale_decimals: 9,
      allowlisted: false,
      min_commitment_usd: "10.00",
      wallet_cap_usd: "25000.00",
      min_commitment_atoms: "10000000",
      wallet_cap_atoms: "25000000000",
      ...overrides,
    },
    terms: { presale_price_usd: "0.000556", presale_price_quote: "0.000556", supply: { total: "1000000000000000000" } },
    vesting: { start_ms: START, cliff_end_ms: START + 3 * MONTH, end_ms: START + 12 * MONTH },
    ...rest,
  };
}

const wallet = (coins: SocialWallet["coins"]): SocialWallet => ({
  address: `0x${"a1".repeat(32)}`,
  signer: "privy",
  fee: "sponsored",
  coins,
  as_of_ms: START,
});

const coin = (type: string, symbol: string, decimals: number, atoms: string, price: string | null) => ({
  coin_type: type,
  symbol,
  name: symbol,
  decimals,
  atoms,
  usd_price: price,
  value_usd: null,
  icon_url: null,
  presale: null,
});

test("§4: a USDC sale is quoted in dollars, and the reads' USD becomes the sale's own coin", () => {
  const read = commitSaleOf(sale(), { suiUsd: 3.42 });
  assert.deepEqual(read, {
    presaleId: PRESALE,
    name: "Meridian",
    symbol: "MRDN",
    lifecycle: "open",
    endMs: START + 86_400_000,
    quoteCoin: "USDC",
    quoteType: COMMIT_COIN_TYPES.USDC,
    quoteDecimals: 6,
    minCommitment: 10,
    walletCap: 25_000,
    allowlisted: false,
    raised: 184_221,
    target: 250_000,
    presalePrice: 0.000_556,
  });
});

/** Driftwood (the dev SUI sale): 25 SUI minimum, 5,000 SUI cap, 99,970 of 100,000 SUI, in nine-decimal atoms. */
const suiRead = (rest: Partial<Omit<CommitSaleRead, "presale">> = {}) => sale({
  quote_type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", quote_symbol: "SUI", quote_decimals: 9, min_commitment_atoms: "25000000000", wallet_cap_atoms: "5000000000000",
  raised_atoms: "99970000000000", target_atoms: "100000000000000", min_commitment_usd: "85.50", wallet_cap_usd: "17100.00",
}, { terms: { presale_price_usd: "0.000760", presale_price_quote: "0.000222222222", supply: { total: "1000000000000000000" } }, ...rest });

test("R3-41: a SUI-quoted sale's minimum, cap, raise and price are the chain's own figures in SUI, from its atoms, with or without a price", () => {
  const read = commitSaleOf(suiRead(), { suiUsd: 3.42 });
  assert.ok(read);
  assert.equal(read.quoteCoin, "SUI");
  assert.equal(read.quoteDecimals, 9);
  assert.deepEqual([read.minCommitment, read.walletCap, read.raised, read.target, read.presalePrice], [25, 5_000, 99_970, 100_000, 0.000222222222]);
  // No conversion is involved, so a missing SUI price changes nothing: the minimum never vanishes.
  const unpriced = commitSaleOf(suiRead(), { suiUsd: null });
  assert.deepEqual([unpriced?.minCommitment, unpriced?.walletCap, unpriced?.raised, unpriced?.presalePrice], [25, 5_000, 99_970, 0.000222222222]);
  assert.equal(quoteCoinOf("usdc"), "USDC");
  assert.equal(quoteCoinOf("sui"), "SUI");
  assert.equal(quoteCoinOf("WAL"), "WAL");
});

test("the purchase preview values a quote coin even when the wallet holds none", () => {
  const quoteType = `0x${"17".repeat(32)}::sui::SUI`;
  const detail = sale({ quote_type: quoteType, quote_symbol: "SUI" }, {
    quote_price: { usd_price: "0.25", as_of_ms: START - 10_000 },
  });
  const read = commitSaleOf(detail, { suiUsd: 3.42 }, START)!;
  const viewer = commitViewerOf({
    wallet: wallet([coin(COMMIT_COIN_TYPES.SUI, "SUI", 9, "9000000000", "3.42")]),
    sale: read,
    entry: null,
    allowlist: null,
  });
  assert.deepEqual([viewer.quoteBalance, viewer.quoteUsd], [0, 0.25]);
  const input = { sale: read, viewer, payWith: "WAL", typed: "1", why: "", whyError: null, blockers: [], nowMs: START };
  assert.equal(commitAmounts(fundedPaymentInput(input, "12000000", 6)).usd, 3);
});

test("a purchase hold cannot spend at an indexed price that expires before release", () => {
  const quoteType = `0x${"17".repeat(32)}::coin::COIN`;
  const detail = sale({ quote_type: quoteType, quote_symbol: "COIN" }, {
    quote_price: { usd_price: "0.25", as_of_ms: START - 119_000 },
  });
  const held = wallet([coin(quoteType, "COIN", 6, "900000000", null)]);
  const read = commitSaleOf(detail, { suiUsd: null }, START);
  const viewer = commitViewerOf({ wallet: held, sale: read, entry: null, allowlist: null });
  const cached = { detail, sale: read, wallet: held, viewer, blockers: [], proof: null };
  const fresh = quickInput(commitFactsAt(cached, START), 100, START, null);
  assert.equal(fresh && "input" in fresh && fresh.input.typed, "400");
  assert.deepEqual(quickInput(commitFactsAt(cached, START + 2_000), 100, START + 2_000, null), {
    refusal: HOLD_COIN_NO_PRICE,
  });
  const independentlyPriced = { ...cached, wallet: wallet([coin(quoteType, "COIN", 6, "900000000", "0.50")]) };
  const repriced = quickInput(commitFactsAt(independentlyPriced, START + 2_000), 100, START + 2_000, null);
  assert.equal(repriced && "input" in repriced && repriced.input.typed, "200");
});

test("§4: an allowlisted sale publishes no minimum and no wallet cap", () => {
  const read = commitSaleOf(sale({ allowlisted: true, min_commitment_usd: null, wallet_cap_usd: null }), { suiUsd: 3.42 });
  assert.deepEqual([read?.allowlisted, read?.minCommitment, read?.walletCap], [true, null, null]);
});

test("§4: an allowlist leaf's cap is quote atoms, scaled once; its proof reaches the transaction untouched", () => {
  const wallet = `0x${"a1".repeat(32)}`;
  const leaf = { index: "3", wallet_cap: "5000000000", proof: ["ab".repeat(32), "cd".repeat(32)] };
  // $5,000 in USDC atoms (6 decimals), never 5 billion dollars.
  const usdc = allowlistLeafOf(leaf, wallet, "USDC");
  assert.equal(usdc?.cap, 5_000);
  assert.deepEqual(usdc?.proof, { index: 3n, wallet, walletCap: 5_000_000_000n, proof: leaf.proof });
  // The same atoms in a SUI sale are 5 SUI (9 decimals).
  assert.equal(allowlistLeafOf(leaf, wallet, "SUI")?.cap, 5);
  assert.deepEqual(COMMIT_COIN_DECIMALS, { USDC: 6, SUI: 9 });
  // A leaf that is not a u64 is not a leaf: the host reads it as an unreadable list.
  assert.equal(allowlistLeafOf({ ...leaf, wallet_cap: "5.5" }, wallet, "USDC"), null);
  assert.equal(allowlistLeafOf({ ...leaf, index: "-1" }, wallet, "USDC"), null);
});

test("§4: the viewer's balances and own commitment come from the reads, in the sale's coin", () => {
  const read = commitSaleOf(sale(), { suiUsd: 3.42 });
  const coins = [
    coin(COMMIT_COIN_TYPES.USDC, "USDC", 6, "860000000", "1"),
    coin(COMMIT_COIN_TYPES.SUI, "SUI", 9, "412380000000", "3.42"),
  ];
  const viewer = commitViewerOf({ wallet: wallet(coins), sale: read, entry: { following: [], following_total_usd: "0", following_total_atoms: "0", mine: { commitment_usd: "500.00", commitment_atoms: "600000000", claim_wallet_commitment_atoms: "500000000", commits: [], claimed: false, refund_usd: null, refund_atoms: "0" } }, allowlist: null });
  assert.deepEqual(viewer, { usdc: 860, sui: 412.38, suiUsd: 3.42, committed: 500, allowlist: null, quoteCoin: "USDC", quoteBalance: 860, quoteUsd: 1 });
  // A wallet that could not be read holds nothing and prices nothing.
  assert.deepEqual(commitViewerOf({ wallet: null, sale: read, entry: null, allowlist: null }), {
    quoteCoin: "USDC", quoteBalance: 0, quoteUsd: 1,
    usdc: 0,
    sui: 0,
    suiUsd: null,
    committed: 0,
    allowlist: null,
  });
  // A SUI-quoted sale counts the commitment in SUI.
  const suiSale = commitSaleOf(suiRead(), { suiUsd: 3.42 });
  const suiViewer = commitViewerOf({ wallet: wallet(coins), sale: suiSale, entry: { following: [], following_total_usd: "0", following_total_atoms: "0", mine: { commitment_usd: "342.00", commitment_atoms: "100000000000", claim_wallet_commitment_atoms: "100000000000", commits: [], claimed: false, refund_usd: null, refund_atoms: "0" } }, allowlist: null });
  assert.equal(suiViewer.committed, 100);
  assert.deepEqual(walletCoin(wallet(coins), COMMIT_COIN_TYPES.USDC), { amount: 860, usdPrice: 1 });
  assert.deepEqual(walletCoin(wallet(coins), "0x9::nope::NOPE"), { amount: 0, usdPrice: null });
  assert.deepEqual(walletCoin(wallet([{ ...coins[0]!, decimals: null }]), COMMIT_COIN_TYPES.USDC), { amount: 0, usdPrice: null });
});

test("§11: the three fact tiles are the reference's, and an unread projection shows em dashes", () => {
  assert.deepEqual(saleFacts(sale()), [
    { label: "Presale price", value: "$0.000556", note: "per MRDN" },
    { label: "FDV at presale", value: "$556K", note: "1B supply" },
    { label: "Buyer vesting", value: "Unavailable", note: "check the presale page" },
  ]);
  // No vesting at all, and vesting with no cliff.
  assert.equal(saleFacts(sale({}, { terms: { ...sale().terms!, buyer_vesting: null } }))[2]!.note, "full allocation at claim");
  assert.equal(saleFacts(sale({}, { terms: { ...sale().terms!, buyer_vesting: { cliff_ms: "0", duration_ms: String(6 * MONTH) } } }))[2]!.note, "From your claim");
  // The terms come from the presale projection, which may be unreadable.
  const blind = saleFacts(sale({}, { terms: null }));
  assert.deepEqual([blind[0]!.value, blind[1]!.value, blind[1]!.note], ["—", "—", null]);
});

test("R3-40: a SUI-quoted sale's dialog reads in SUI — price, FDV and the target a pending sale needs — with no price needed", () => {
  assert.deepEqual(saleFacts(suiRead()).slice(0, 2), [
    { label: "Presale price", value: "0.000222 SUI", note: "per MRDN" },
    { label: "FDV at presale", value: "222K SUI", note: "1B supply" },
  ]);
  assert.match(saleDialogLine(sale({ phase: "pending", quote_type: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", quote_symbol: "SUI", quote_decimals: 9, target_atoms: "100000000000000" }), START), /Needs 100,000 SUI to succeed\./);
});

test("§11: each lifecycle's line is the reference's words", () => {
  const now = START + 1_000;
  assert.match(saleDialogLine(sale({ phase: "pending" }), now), /^Needs 250,000 USDC to succeed\. 1,840 people are following it\.$/);
  assert.equal(saleDialogLine(sale({ phase: "pending", interested: 1 }), now).endsWith("1 person is following it."), true);
  assert.equal(
    saleDialogLine(sale({ phase: "funded", raised_usd: "311400.00", target_usd: "250000.00", venue: "bluefin" }), now),
    "Funded, 1.25× oversubscribed. Claims open when trading starts on Bluefin.",
  );
  assert.equal(saleDialogLine(sale({ phase: "trading", multiple: "4.2000" }), now), "Trading on Cetus at 4.2× the presale price.");
  assert.equal(saleDialogLine(sale({ phase: "trading", multiple: null }), now), "Trading on Cetus.");
  assert.equal(saleDialogLine(sale({ phase: "cancelled" }), now), "The target was missed, so everyone can claim a full refund.");
  // `closed` is this app's phase, which the reference has no state for.
  assert.equal(saleDialogLine(sale({ phase: "closed" }), now), "It closed. Blast is settling it on Sui; claims open once it has.");
});

test("§11: the footer link is quiet beside a primary action and a full-width button alone — the gate's rule", () => {
  // Driven in the acceptance gate: a pending sale renders `a.sheet-link` next
  // to "Notify me", every other state `a.btn.btn-line.btn-lg.btn-block`.
  // `FEATURE-MAP-R3.md` §11 and `R3-DELTA.md` §11 both state the reverse; the
  // gate wins (OA-23) and the conflict is in the ticket's record.
  assert.equal(saleFooterLinkStyle("pending"), "quiet");
  for (const phase of ["open", "closed", "funded", "trading", "cancelled"] as const) {
    assert.equal(saleFooterLinkStyle(phase), "button", phase);
  }
});

test("§11: the dialog's accessible name is the gate's string, and the via line names the right person", () => {
  assert.equal(commitDialogLabel("Meridian"), "Blast into Meridian");
  const item = (actor: FeedItem["actor"]): FeedItem =>
    ({ actor } as FeedItem);
  assert.equal(sourceThroughName(item({ type: "account", callsign: "mira", display_name: "Mira Solis", avatar_url: null, x_handle: null, verified: true, path: "/@mira" }), "kai"), "Mira");
  assert.equal(sourceThroughName(item({ type: "account", callsign: "mira", display_name: null, avatar_url: null, x_handle: null, verified: false, path: "/@mira" }), "kai"), "mira");
  // One's own post names nobody, and an unnamed actor has no name to show.
  assert.equal(sourceThroughName(item({ type: "account", callsign: "kai", display_name: "Kai", avatar_url: null, x_handle: null, verified: true, path: "/@kai" }), "kai"), null);
  assert.equal(sourceThroughName(item({ type: "address", address: `0x${"f".repeat(64)}`, short: "0xffff…ffff" }), "kai"), null);
  assert.equal(sourceThroughName(null, "kai"), null);
});

test("§4: the sale read's guard accepts the detail route's answer and refuses a broken one", () => {
  assert.ok(isCommitSaleRead(sale()));
  assert.ok(isCommitSaleRead(sale({}, { terms: null, vesting: null })));
  assert.ok(!isCommitSaleRead(null));
  assert.ok(!isCommitSaleRead({ presale: {} }));
  assert.ok(!isCommitSaleRead({ ...sale(), presale: { ...sale().presale, phase: "weird" } }));
  assert.ok(!isCommitSaleRead({ ...sale(), presale: { ...sale().presale, fill_bps: "7368" } }));
  assert.ok(!isCommitSaleRead({ ...sale(), terms: { presale_price_usd: "1" } }));
  // The two coin types are the ones the wallet read keys its balances by.
  assert.equal(COMMIT_COIN_TYPES.USDC, "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC");
  assert.equal(COMMIT_COIN_TYPES.SUI, `0x${"0".repeat(63)}2::sui::SUI`);
});

test("§4: a decimal string from a contract is a number only when it really is one", () => {
  assert.equal(decimal("184221.00"), 184_221);
  assert.equal(decimal("0"), 0);
  assert.equal(decimal("-3.5"), -3.5);
  assert.equal(decimal(null), null);
  assert.equal(decimal(undefined), null);
  assert.equal(decimal(""), null);
  assert.equal(decimal("1e3"), null);
  assert.equal(decimal("01"), null);
  assert.equal(decimal("NaN"), null);
});

test("T-024: a sale page's ?via= is the post it credits, and nothing that is not an entry id is passed on", () => {
  assert.equal(viaEntryOf("?via=a:12:0:0:0"), "a:12:0:0:0");
  assert.equal(viaEntryOf("?amount=50&via=l:0xabc:opened"), "l:0xabc:opened");
  assert.equal(viaEntryOf(""), null);
  assert.equal(viaEntryOf("?via="), null);
  assert.equal(viaEntryOf("?via=https://evil.example"), null);
  assert.equal(viaEntryOf(`?via=a:${"x".repeat(251)}`), null);
});

test("TSUI presales use the exact quote type, nine-decimal balances and allowlist cap without a USD price", () => {
  const type = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";
  const read = commitSaleOf(sale({ quote_type: type, quote_symbol: "TSUI", quote_decimals: 9, min_commitment_atoms: "1000000001" }), { suiUsd: 3.42 })!;
  assert.equal(read.quoteType, type);
  assert.equal(read.minCommitment, 1.000000001);
  const viewer = commitViewerOf({ wallet: wallet([coin(type, "TSUI", 9, "25000000001", null)]), sale: read, entry: null, allowlist: null });
  assert.deepEqual([viewer.quoteCoin, viewer.quoteBalance, viewer.quoteUsd], ["TSUI", 25.000000001, null]);
  assert.equal(allowlistLeafOf({ index: "0", wallet_cap: "5000000001", proof: [] }, wallet([]).address!, "TSUI", 9)?.cap, 5.000000001);
  assert.equal(allowlistLeafOf({ index: "0", wallet_cap: "5", proof: [] }, wallet([]).address!, "TSUI"), null);
});

test("an open dialog drops the leaf cap on day five and uses the public minimum", () => {
  const day = 86_400_000;
  const from_ms = START + 4 * day;
  const detail = sale({ allowlisted: true, end_ms: START + 5 * day, quote_decimals: 9 });
  const terms = { ...detail.terms!, public_buy: { from_ms, min_atoms: "1083560581", hard_cap_from_ms: START } };
  const read = (now: number) => commitSaleOf({ ...detail, terms }, { suiUsd: null }, now)!;
  assert.equal(read(from_ms - 1).allowlisted, true);
  assert.deepEqual([read(from_ms).allowlisted, read(from_ms).minCommitment, read(from_ms).walletCap], [false, 1.083560581, null]);
  assert.equal(read(START + 5 * day).publicBuy, undefined);
  const cached = {
    detail: { ...detail, terms }, sale: read(from_ms - 1), wallet: null, proof: null,
    viewer: commitViewerOf({ wallet: null, sale: read(from_ms - 1), entry: null, allowlist: { on: false, cap: null } }),
    blockers: ["allowlist_unavailable", "wallet_missing"] as const,
  };
  assert.equal(commitFactsAt(cached, from_ms - 1), cached);
  const opened = commitFactsAt(cached, from_ms);
  assert.equal(opened.sale?.allowlisted, false);
  assert.equal(opened.viewer.allowlist, null);
  assert.deepEqual(opened.blockers, ["wallet_missing"]);
  assert.equal(commitFactsAt(opened, from_ms + 1), opened);
});

test("a full wallet can commit again when the eligible-only cap lifts", () => {
  const from = START + 1_000;
  const detail = sale({ allowlisted: true, min_commitment_atoms: null, min_commitment_usd: null });
  const read = commitSaleOf({
    ...detail,
    terms: { ...detail.terms!, eligible_uncapped_from_ms: from },
  }, { suiUsd: null }, from - 1)!;
  const viewer = {
    ...commitViewerOf({ wallet: wallet([coin(COMMIT_COIN_TYPES.USDC, "USDC", 6, "100000000", "1")]), sale: read, entry: null, allowlist: { on: true, cap: 25 } }),
    committed: 25,
  };
  const input = { sale: read, viewer, typed: "1", payWith: "USDC", blockers: [], why: "", whyError: null } as const;
  assert.equal(commitRefusal({ ...input, nowMs: from - 1 }), "allocation_used");
  assert.equal(commitRefusal({ ...input, nowMs: from }), null);
  assert.equal(commitRefusal({ ...input, nowMs: from, viewer: { ...viewer, allowlist: { on: false, cap: null } } }), "allowlist");
});
