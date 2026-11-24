import assert from "node:assert/strict";
import test from "node:test";

import type { HomeActivity, HomeAmount, HomeCoin, HomeEvent, HomeParticipant, HomeSide } from "@blast/core/modules/social/contracts/home.ts";

import {
  activeFilterCount,
  discoverQueryOf,
  sameListView,
  withView,
  HOME_DEFAULT_FEED,
  HOME_DEFAULT_VIEW,
  resultsAnnouncement,
  viewSearchOf,
  viewStateOf,
} from "./home-state";
import {
  amountShort,
  amountText,
  eventLine,
  eventSentence,
  followersText,
  homeCoinHref,
  marketFacts,
  namesOf,
  participantLabel,
  directionCounts,
  participantSideLines,
  poolSummaryParts,
  raiseFigures,
  sideLine,
  volumeText,
  tapeParts,
  usdText,
  pnlText,
  portfolioText,
  shareText,
} from "./home-model";

/** The coin item's words and the view's URL, as plain values. */

const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
const ORBIT = { symbol: "ORBIT", decimals: 9 };
const NOW = 1_791_700_000_000;

const amount = (over: Partial<HomeAmount> = {}): HomeAmount => ({ quote_type: USDC, quote_symbol: "USDC", quote_decimals: 6, atoms: "370000000", usd: "370.00", usd_complete: true, ...over });
const sui = (atoms: string, over: Partial<HomeAmount> = {}): HomeAmount => amount({ quote_type: SUI, quote_symbol: "SUI", quote_decimals: 9, atoms, usd: null, usd_complete: false, ...over });
const side = (over: Partial<HomeSide> = {}): HomeSide => ({ count: 1, amounts: [amount()], tokens: "24000000000000", latest_ms: NOW - 240_000, ...over });
const maya: HomeParticipant = {
  key: "c:maya", actor: { type: "account", callsign: "maya", display_name: "Maya Park", avatar_url: null, x_handle: null, verified: true, path: "/@maya" },
  followers: 24, buys: side({ count: 3, amounts: [sui("100000000000")] }), sells: side({ amounts: [sui("25000000000")], latest_ms: NOW - 120_000, tokens: "8000000000000" }),
  commits: null, claims: null, latest_ms: NOW - 120_000, latest_kind: "trade_sell", events_total: 4, relation: "followed",
};
const wallet: HomeParticipant = {
  key: "w:0xabc", actor: { type: "address", address: `0x${"ab".repeat(32)}`, short: "0xabab…abab" }, followers: null,
  buys: side({ amounts: [amount({ atoms: "7000000", usd: "7.00" })] }), sells: null, commits: null, claims: null, latest_ms: NOW - 900_000, latest_kind: "trade_buy", events_total: 1,
};
const activity = (over: Partial<HomeActivity> = {}): HomeActivity => ({
  scope: "pool", window: "24h", from_ms: NOW - 86_400_000, to_ms: NOW, participants: 6, events: 10, buyers: 5, sellers: 2, backers: 0, claimers: 0,
  bought: [amount()], sold: [amount({ atoms: "65000000", usd: "65.00" })], committed: [], latest_ms: NOW - 120_000, preview: [maya, wallet], ...over,
});

test("amounts name their asset: USDC as dollars, SUI in SUI, an unknown asset said so; USD only as priced", () => {
  assert.equal(amountText(amount()), "$370");
  assert.equal(amountText(sui("100000000000")), "100 SUI");
  assert.equal(amountText(sui("1234500000000")), "1,234.5 SUI");
  assert.equal(amountText(amount({ quote_symbol: null, quote_decimals: null })), "an unlisted coin");
  assert.equal(amountShort(sui("400000000000000")), "400K SUI");
  assert.equal(amountShort(amount({ atoms: "1250000000", usd: null })), "1.3K USDC");
  assert.equal(usdText(amount()), "$370");
  assert.equal(usdText(amount({ usd: "370.00", usd_complete: false })), "$370+");
  assert.equal(usdText(sui("1")), null);
});

test("a direction reads what was spent or received, the coin, and whether it was one trade or several", () => {
  assert.equal(sideLine("trade_buy", maya.buys!, ORBIT), "Bought 100 SUI · 3 trades");
  assert.equal(sideLine("trade_sell", maya.sells!, ORBIT), "Sold for 25 SUI");
  assert.equal(sideLine("presale_commit", side({ count: 2, amounts: [amount({ atoms: "150000000", usd: "150.00" })] }), ORBIT), "Backed with $150 · 2 commitments");
  assert.equal(sideLine("presale_claim", side({ amounts: [], tokens: "500000000000" }), ORBIT), "Claimed 500 ORBIT");
  assert.equal(sideLine("presale_claim", side({ amounts: [amount({ atoms: "20000000", usd: "20.00" })], tokens: null }), ORBIT), "Claimed tokens and $20 back");
  // A zero refund is not said.
  assert.equal(sideLine("presale_claim", side({ amounts: [amount({ atoms: "0", usd: "0.00" })], tokens: "500000000000" }), ORBIT), "Claimed 500 ORBIT");
});

test("events say both legs: spent → received, sold → received, committed, claimed", () => {
  const event = (over: Partial<HomeEvent>): HomeEvent => ({ activity_id: "1:0:0:0", entry_id: "a:1:0:0:0", kind: "trade_buy", occurred_at_ms: NOW, digest: null, quote: sui("100000000000"), tokens: "24000000000000", refund: null, has_why: false, ...over });
  assert.equal(eventLine(event({}), ORBIT), "100 SUI → 24,000 ORBIT");
  assert.equal(eventLine(event({ kind: "trade_sell", quote: sui("40000000000"), tokens: "8000000000000" }), ORBIT), "8,000 ORBIT → 40 SUI");
  assert.equal(eventLine(event({ kind: "presale_commit", quote: amount(), tokens: null }), ORBIT), "Committed $370");
  assert.equal(eventLine(event({ kind: "presale_claim", quote: null, tokens: "500000000000" }), ORBIT), "Claimed 500 ORBIT");
  assert.equal(eventLine(event({ kind: "presale_claim", quote: amount({ atoms: "0" }), tokens: "500000000000", refund: "0" }), ORBIT), "Claimed 500 ORBIT");
  assert.equal(eventLine(event({ kind: "presale_claim", quote: amount({ atoms: "0" }), tokens: null, refund: "20000000" }), ORBIT), "Refunded $20");
  // One sentence per event, the verb once: the thread's single line and each disclosed row.
  assert.equal(eventSentence(event({}), ORBIT), "Bought 100 SUI → 24,000 ORBIT");
  assert.equal(eventSentence(event({ kind: "trade_sell", quote: sui("40000000000"), tokens: "8000000000000" }), ORBIT), "Sold 8,000 ORBIT → 40 SUI");
  assert.equal(eventSentence(event({ kind: "trade_sell", quote: sui("40000000000"), tokens: null }), ORBIT), "Sold for 40 SUI");
  assert.equal(eventSentence(event({ kind: "presale_commit", quote: amount(), tokens: null }), ORBIT), "Backed with $370");
  assert.equal(eventSentence(event({ kind: "presale_claim", quote: null, tokens: "500000000000" }), ORBIT), "Claimed 500 ORBIT");
});

test("names: accounts by name, wallets by address, a count when nobody is named", () => {
  assert.equal(namesOf([maya, wallet], 2), "Maya and 0xabab…abab");
  assert.equal(namesOf([], 3), "3 people");
});

test("participants and followers: a wallet is a wallet, a small follower count says nothing, a known one says Blast", () => {
  assert.equal(participantLabel(maya), "Maya Park, you follow, 24 followers on Blast");
  assert.equal(participantLabel(wallet), "0xabab…abab, a wallet");
  assert.equal(followersText(4), null);
  assert.equal(followersText(null), null);
  assert.equal(followersText(1_200), "1,200 followers on Blast");
});

test("market facts carry their period and show a dash, never 0, when unknown", () => {
  const coin = {
    presale_id: "0x1", coin_type: "0x1::c::C", symbol: "ORBIT", name: "Orbit", icon_url: null, decimals: 9, lifecycle: "migrated", venue: "cetus", tradable: true,
    opened_ms: NOW - 4 * 86_400_000, launched_ms: NOW - 2 * 3_600_000, launch_id: null, quote: { type: USDC, symbol: "USDC", decimals: 6 },
    sale: { start_ms: 0, end_ms: 0, raise_target: "1", raised: "1", participants: 1 },
    price_usd: "0.05", price_as_of_ms: NOW, change_24h_bps: 2500, holders: 42, holders_as_of_ms: NOW, fdv_usd: "50000.00", spark: [],
    activity: activity(), top_holders: { holders: [], share_bps: null }, discussion: { posts: 2 }, rank: { score: 1, why: "x" },
  } satisfies HomeCoin;
  assert.deepEqual(marketFacts(coin, NOW), { price: "$0.05", change: { text: "+25%", up: true }, holders: "42", fdv: "$50K", age: "Launched 2h ago" });
  assert.deepEqual(marketFacts({ ...coin, price_usd: null, change_24h_bps: null, holders: null, fdv_usd: null, launched_ms: null }, NOW), { price: null, change: null, holders: null, fdv: null, age: null });
});

test("a sale opens its presale page, a curve coin its coin page, and a coin with neither has no link", () => {
  assert.equal(homeCoinHref({ coin_type: "0x1::coin::COIN", presale_id: "0xsale", launch_id: null }), "/presale/0xsale");
  assert.equal(homeCoinHref({ coin_type: "0x1::coin::COIN", presale_id: null, launch_id: "0xlaunch" }), "/coin/0x1%3A%3Acoin%3A%3ACOIN");
  assert.equal(homeCoinHref({ coin_type: "0x1::coin::COIN", presale_id: null, launch_id: null }), null);
});

test("the view state round-trips through the URL, with defaults left out and unknown values read as defaults", () => {
  assert.deepEqual(viewStateOf(new URLSearchParams("")), HOME_DEFAULT_FEED);
  const defaultQuery = discoverQueryOf(viewStateOf(new URLSearchParams("")));
  assert.equal(defaultQuery.sort, "relevant");
  assert.equal(defaultQuery.window, "1h");
  assert.equal(defaultQuery.traction, true);
  assert.equal(discoverQueryOf(HOME_DEFAULT_FEED, 5).limit, 20);
  assert.equal(viewStateOf(new URLSearchParams("w=24h")).window, "24h");
  assert.equal(viewSearchOf(viewStateOf(new URLSearchParams("w=1h"))), "");
  assert.equal(viewSearchOf(viewStateOf(new URLSearchParams("sort=relevant"))), "?sort=relevant");
  const state = { source: "following", sort: "newest", window: "24h", minParticipants: 5, age: "7d", tradable: true, page: 3 } as const;
  assert.equal(viewSearchOf(state), "?src=following&sort=newest&w=24h&min=5&age=7d&tradable=1&page=3");
  assert.deepEqual(viewStateOf(new URLSearchParams(viewSearchOf(state))), state);
  assert.equal(viewSearchOf(HOME_DEFAULT_FEED), "");
  assert.equal(viewSearchOf(HOME_DEFAULT_VIEW), "?sort=held");
  assert.deepEqual(viewStateOf(new URLSearchParams("src=x&sort=cap&w=7d&min=3&age=1d&tradable=yes&page=0")), HOME_DEFAULT_FEED);
  // The page: an integer from 1; anything else (0, a fraction, a word, beyond the last page allowed) is page 1.
  assert.equal(viewStateOf(new URLSearchParams("page=12")).page, 12);
  assert.equal(viewStateOf(new URLSearchParams("page=12")).sort, "held");
  for (const bad of ["page=0", "page=1.5", "page=two", "page=10000", "page=-2"]) assert.equal(viewStateOf(new URLSearchParams(bad)).page, 1, bad);
  assert.equal(activeFilterCount(state), 3);
  assert.equal(activeFilterCount(HOME_DEFAULT_VIEW), 0);
  assert.deepEqual(discoverQueryOf(state), { window: "24h", sort: "newest", minParticipants: 5, age: "7d", tradable: true, limit: 10, page: 3, cursor: null });
  assert.equal(discoverQueryOf(state, 20).limit, 20);
  assert.equal(resultsAnnouncement(state, 3), "Following · 3 coins · last 24 hours");
  assert.equal(resultsAnnouncement(state, 47, 5), "Following · 47 coins · page 3 of 5 · last 24 hours");
  assert.equal(resultsAnnouncement(HOME_DEFAULT_VIEW, 1), "Discover · 1 coin · sorted by Most held · last hour");
  // Any change but the page itself starts the list on page 1; the page alone keeps the list.
  assert.deepEqual(withView(state, { ...state, page: 5 }), { ...state, page: 5 });
  assert.deepEqual(withView(state, { ...state, sort: "trending" }), { ...state, sort: "trending", page: 1 });
  assert.deepEqual(withView(state, { ...state, source: "discover", page: 3 }), { ...state, source: "discover", page: 1 });
  assert.equal(sameListView(state, { ...state, page: 9 }), true);
  assert.equal(sameListView(state, { ...state, window: "1h" }), false);
});

test("the card's marks follow the words: each count and each line carries its direction; the raise reads in the sale's coin", () => {
  const pool = activity({ backers: 0, claimers: 1 });
  assert.deepEqual(poolSummaryParts(pool), {
    counts: [["trade_buy", "5 bought"], ["trade_sell", "2 sold"], ["presale_claim", "1 claimed"]],
    tail: " in the last 24h · 6 participants",
  });
  assert.deepEqual(poolSummaryParts(activity({ buyers: 0, sellers: 0, participants: 0, events: 0 })), { counts: [], tail: "No activity in its pool in the last 24h" });
  // Maya's latest direction leads, each with its glyph's kind.
  assert.deepEqual(participantSideLines(maya, ORBIT).map(([kind]) => kind), ["trade_sell", "trade_buy"]);
  assert.deepEqual(participantSideLines(maya, ORBIT).map(([, line]) => line), ["Sold for 25 SUI", "Bought 100 SUI · 3 trades"], "two lines, never a net");
  const usdc = { quote: { type: USDC, symbol: "USDC", decimals: 6 }, sale: { start_ms: 0, end_ms: 0, raise_target: "100000000000", raised: "175000000", participants: 4 } };
  assert.deepEqual(raiseFigures(usdc), { raised: "$175", target: "$100K" });
  const suiSale = { quote: { type: SUI, symbol: "SUI", decimals: 9 }, sale: { start_ms: 0, end_ms: 0, raise_target: "400000000000000", raised: "399000000000000", participants: 40 } };
  assert.deepEqual(raiseFigures(suiSale), { raised: "399K SUI", target: "400K SUI" });
});

test("the row's line: counts by direction (a sell never dropped), the tape's line and the window's volume", () => {
  assert.deepEqual(directionCounts(activity()), [["trade_buy", 5], ["trade_sell", 2]]);
  assert.deepEqual(directionCounts(activity({ buyers: 0, sellers: 0, backers: 3, claimers: 1 })), [["presale_commit", 3], ["presale_claim", 1]]);
  assert.deepEqual(directionCounts(activity({ buyers: 0, sellers: 0 })), []);
  assert.deepEqual(tapeParts({ kind: "trade_sell", quote: amount({ atoms: "25000000", usd: "25.00" }) }), { before: "sold $25 of", after: "" });
  assert.deepEqual(tapeParts({ kind: "trade_buy", quote: sui("100000000000") }), { before: "bought 100 SUI of", after: "" });
  assert.deepEqual(tapeParts({ kind: "presale_commit", quote: amount({ atoms: "150000000", usd: "150.00" }) }), { before: "backed", after: "with $150" });
  assert.deepEqual(tapeParts({ kind: "presale_claim", quote: null }), { before: "claimed", after: "" });
  // The window's volume: bought and sold in dollars, a plus where a row was unpriced, nothing without a figure.
  assert.equal(volumeText(activity()), "$435");
  assert.equal(volumeText(activity({ bought: [amount({ usd: "1200.00" })], sold: [sui("1000000000")] })), "$1.2K+");
  assert.equal(volumeText(activity({ bought: [sui("1000000000")], sold: [] })), null);
});

test("a trader's portfolio, P&L and a holder's share as the row writes them", () => {
  assert.equal(portfolioText("1234.50"), "$1.2K");
  assert.equal(portfolioText(null), null);
  assert.deepEqual(pnlText("120.00"), { text: "+$120", tone: "up" });
  assert.deepEqual(pnlText("-45.10"), { text: "−$45", tone: "down" });
  assert.deepEqual(pnlText("0.00"), { text: "$0", tone: "flat" });
  assert.equal(pnlText(null), null);
  // Home's Top traders write the whole figure (Main board: `+$184,220`); cents below $100.
  assert.deepEqual(pnlText("184220.40", "full"), { text: "+$184,220", tone: "up" });
  assert.deepEqual(pnlText("-3940.00", "full"), { text: "−$3,940", tone: "down" });
  assert.deepEqual(pnlText("-12.40", "full"), { text: "−$12.40", tone: "down" });
  assert.deepEqual(pnlText("0.004", "full"), { text: "$0", tone: "flat" });
  assert.equal(pnlText(null, "full"), null);
  assert.deepEqual([shareText(4100), shareText(50), shareText(4), shareText(0), shareText(null)], ["41%", "0.5%", "<0.1%", "0%", null]);
});

test("no indexed turnover is zero; unpriced trades remain unavailable", () => {
  assert.equal(volumeText(activity({ bought: [], sold: [], committed: [] })), "$0");
  assert.equal(volumeText(activity({ bought: [sui("1000000000")], sold: [], committed: [] })), null);
});

test("a positive volume under a dollar keeps its cents and never reads $0; a priced zero stays $0", () => {
  const priced = (usd: string) => amount({ usd });
  const only = (bought: HomeAmount[], sold: HomeAmount[] = []) => volumeText(activity({ bought, sold, committed: [] }));
  assert.equal(only([priced("0.05")]), "$0.05");
  assert.equal(only([priced("0.03")], [priced("0.12")]), "$0.15");
  assert.equal(only([priced("0.0000001")]), "$0.0₆1");
  assert.equal(only([priced("0.05")], [sui("1000000000")]), "$0.05+");
  assert.equal(only([priced("0.00")]), "$0");
  assert.equal(only([priced("1.40")]), "$1");
  assert.equal(only([priced("0.9999")]), "$0.9999");
  assert.equal(only([priced("0.005")]), "$0.005");
  // The same rule holds for a trader's portfolio and P&L; a P&L under half a cent stays flat.
  assert.equal(portfolioText("0.30"), "$0.3");
  assert.deepEqual(pnlText("0.30"), { text: "+$0.3", tone: "up" });
  assert.deepEqual(pnlText("-0.05"), { text: "−$0.05", tone: "down" });
  assert.deepEqual(pnlText("0.004"), { text: "$0", tone: "flat" });
});
