import assert from "node:assert/strict";
import test from "node:test";

import type { FeedItem, FeedItemBacker } from "@blast/core/modules/social/contracts/items.ts";

import { feedItem, fixturePresale, FIXTURE_ADDRESS, FIXTURE_NOW } from "../../../../test/fixtures/social/feed-fixtures.ts";
import { TRADE_STORY_MOVES, TRADE_STORY_SALES, tradeStoryItems } from "../../../../test/fixtures/social/home/trade-story.ts";
import { coinMovesOf, whyNowLine } from "./coin-moves-model.ts";
import { ago, count, durationWords, explorerAccountUrl, explorerTxUrl, fullDate, multiple, pct1, px, qty, short, usd, usd0, utc, venueName, walletHue } from "./post-format.ts";
import { canAddWhy, facepile, phoneThroughLine, postMenuItems, postView, whyPrompt } from "./post-model.ts";

/** UI-03 (FEATURE-MAP §0.2, §3): the design's formats and every post variant's words, without a DOM. */

const MIN = 60_000;
const HOUR = 3_600_000;

test("§0.2 formats build the prototype's strings", () => {
  assert.equal(usd(2000), "$2,000");
  assert.equal(usd(1200, 2), "$1,200.00");
  assert.equal(usd0(849.6), "$850");
  for (const [value, text] of [[1_250_000, "$1.25M"], [399_400, "$399K"], [48_200, "$48.2K"], [3_150, "$3.2K"], [860, "$860"]] as const) {
    assert.equal(short(value), text, String(value));
  }
  for (const [value, text] of [[3.42, "$3.42"], [0.2109, "$0.2109"], [0.0005, "$0.0005"], [0.00213, "$0.00213"], [0.0021, "$0.0021"]] as const) {
    assert.equal(px(value), text, String(value));
  }
  for (const [value, text] of [[1.2e9, "1.2B"], [4.1e6, "4.1M"], [600_000, "600,000"], [84_853.4, "84,853"], [12.345, "12.35"]] as const) {
    assert.equal(qty(value), text, String(value));
  }
  assert.equal(count(1012), "1,012");
  assert.equal(multiple(4.2), "4.2×");
  assert.equal(multiple(0.6), "0.6×");
  assert.equal(utc(Date.UTC(2026, 9, 14, 18, 0)), "Oct 14, 18:00 UTC");
  assert.equal(fullDate(Date.UTC(2026, 9, 3, 17, 42), "UTC"), "Oct 3, 5:42 PM");
  assert.equal(venueName("cetus"), "Cetus");
  assert.equal(venueName("bluefin"), "Bluefin");
  assert.equal(venueName("turbos"), "Turbos");
});

test("§0.2 relative time: now under 45 s, then minutes, hours and days, rounded", () => {
  for (const [ms, text] of [[0, "now"], [44_000, "now"], [46_000, "1m"], [6 * MIN, "6m"], [59 * MIN, "59m"], [2 * HOUR, "2h"], [23 * HOUR + 31 * MIN, "24h"], [4 * 24 * HOUR, "4d"]] as const) {
    assert.equal(ago(FIXTURE_NOW - ms, FIXTURE_NOW), text, String(ms));
  }
  // A future time (clock skew) reads "now", never a negative age.
  assert.equal(ago(FIXTURE_NOW + 10_000, FIXTURE_NOW), "now");
  assert.equal(durationWords(6 * HOUR), "6 hours");
  assert.equal(durationWords(HOUR), "60 minutes");
  assert.equal(durationWords(3 * 24 * HOUR), "3 days");
  assert.equal(durationWords(30_000), "1 minute");
});

test("§20: the explorer is Suiscan (mainnet); wallets get the prototype's gradient hue", () => {
  const digest = "8Fq".padEnd(44, "1");
  assert.equal(explorerTxUrl(digest), `https://suiscan.xyz/mainnet/tx/${digest}`);
  assert.equal(explorerTxUrl("not a digest"), null);
  assert.equal(explorerTxUrl(null), null);
  assert.equal(explorerAccountUrl(FIXTURE_ADDRESS), `https://suiscan.xyz/mainnet/account/${FIXTURE_ADDRESS}`);
  assert.equal(explorerAccountUrl("0xabc"), null);
  // The prototype: sum of the short address's char codes mod 360.
  assert.equal(walletHue("0x1a2b…9f0e"), [..."0x1a2b…9f0e"].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 360);
});

const view = (extra: Partial<FeedItem> = {}, viewer: string | null = null) => postView(feedItem(extra), viewer);

test("§3.8 commit (named): name, verified, @handle, BLAST $2,000 [MRDN], the why, Blast, 6 blasted too · $3.2K", () => {
  const post = view();
  assert.ok(post);
  assert.deepEqual(post.header, { kind: "account", name: "Mira Chen", callsign: "mirachen", verified: true, path: "/@mirachen", own: false });
  assert.deepEqual(post.body, { kind: "action", chip: "blast", amount: "$2,000", presale: feedItem().presale, tail: null });
  assert.equal(post.why, "Been using their app for months. First presale I have joined with real size.");
  assert.deepEqual(post.cta, { kind: "commit", label: "Blast" });
  assert.deepEqual(post.through, { people: 6, volume: "$3.2K" });
  assert.equal(post.rockets, 41);
  assert.equal(post.context, null);
  assert.equal(post.followCallsign, "mirachen");
  assert.equal(post.postId, "a-5000-1-0-0");
  assert.equal(post.txUrl, `https://suiscan.xyz/mainnet/tx/${"8Fq".padEnd(44, "1")}`);
  // Whole dollars on posts (the payload's two-place USD is rounded for display).
  assert.equal((view({ amounts: { ...feedItem().amounts!, usd: "2000.49" } })?.body as { amount: string }).amount, "$2,000");
  // Without USD, USDC reads at $1 (owner, 2026-11-14) and another quote in its coin; nobody through the post: no "blasted too".
  assert.equal((view({ amounts: { ...feedItem().amounts!, usd: null } })?.body as { amount: string }).amount, "$2,000");
  assert.equal((view({ amounts: { ...feedItem().amounts!, usd: null, quote_symbol: "WAL" } })?.body as { amount: string }).amount, "2,000 WAL");
  assert.equal(view({ through: { people: 0, volume_usd: "0.00" } })?.through, null);
});

test("§3.8 own commit: the You tag, no Follow and no call to action", () => {
  const own = view({}, "mirachen");
  assert.equal(own?.header.kind === "account" && own.header.own, true);
  assert.equal(own?.cta, null);
  assert.equal(own?.followCallsign, null);
});

test("§3.8 big commit (anonymous): Big blast, the short address, BLAST $12,400, Blast", () => {
  const post = view({ actor: { type: "address", address: FIXTURE_ADDRESS, short: "0x1a2b…9f0e" }, amounts: { ...feedItem().amounts!, usd: "12400.00" }, why: null, through: { people: 0, volume_usd: "0.00" } });
  assert.equal(post?.context, "big-blast");
  assert.deepEqual(post?.header, { kind: "wallet", short: "0x1a2b…9f0e", address: FIXTURE_ADDRESS });
  assert.equal(post?.lead.kind, "wallet");
  assert.equal((post?.body as { amount: string }).amount, "$12,400");
  assert.equal(post?.followCallsign, null);
  assert.deepEqual(post?.cta, { kind: "commit", label: "Blast" });
});

const KESTREL = fixturePresale({
  symbol: "KSTL", name: "Kestrel", lifecycle: "migrated", end_ms: FIXTURE_NOW - 86_400_000,
  market: { presale_price_usd: "0.0005", price_usd: "0.0021", price_as_of_ms: FIXTURE_NOW - 5_000, multiple: "4.2000" },
});
const VIEW = (presaleId: string) => ({ kind: "commit", enabled: false, label: "View presale", href: `/presale/${presaleId}` });

test("§3.4 call (OA-9): CALL [KSTL] backed at $0.0005; card Kestrel / Trading on Cetus · now $0.0021 / 4.2×; View presale", () => {
  const post = view({ call: true, presale: KESTREL, do_the_same: VIEW(KESTREL.presale_id), why: { why_id: "w", text: "Called it at the presale. Intents are how swaps should work." } });
  assert.deepEqual(post?.body, { kind: "action", chip: "call", amount: null, presale: KESTREL, tail: "backed at $0.0005" });
  assert.deepEqual(post?.call, { presale: KESTREL, price: "$0.0021", result: "4.2×", up: true });
  assert.deepEqual(post?.cta, { kind: "view", label: "View presale", presaleId: KESTREL.presale_id });
  // Below the presale price: red.
  const down = view({ call: true, presale: { ...KESTREL, market: { ...KESTREL.market!, price_usd: "0.0003", multiple: "0.6000" } }, do_the_same: VIEW(KESTREL.presale_id) });
  assert.deepEqual([down?.call?.result, down?.call?.up], ["0.6×", false]);
  // The prototype divides the two prices: Lumen at $0.0013 over $0.002 reads 0.6× (the payload's 0.6500 would round to 0.7).
  const lumen = view({ call: true, presale: { ...KESTREL, market: { presale_price_usd: "0.002", price_usd: "0.0013", price_as_of_ms: FIXTURE_NOW, multiple: "0.6500" } }, do_the_same: VIEW(KESTREL.presale_id) });
  assert.deepEqual([lumen?.call?.price, lumen?.call?.result], ["$0.0013", "0.6×"]);
  // A stale price: the card without the price or a result.
  const stale = view({ call: true, presale: { ...KESTREL, market: { presale_price_usd: "0.0005", price_usd: null, price_as_of_ms: null, multiple: null } }, do_the_same: VIEW(KESTREL.presale_id) });
  assert.deepEqual([stale?.call?.price, stale?.call?.result], [null, null]);
});

test("§3.8 claim: CLAIM 4.1M [KSTL] worth $8.6K now, View presale; a refund-only claim reads its dollars", () => {
  const claim = view({
    kind: "presale_claim", presale: { ...KESTREL, decimals: 6 }, do_the_same: VIEW(KESTREL.presale_id), why: null,
    amounts: { quote: "0", quote_symbol: "USDC", quote_decimals: 6, usd: null, tokens: "4100000000000", quote_refund: null },
  });
  assert.deepEqual(claim?.body, { kind: "action", chip: "claim", amount: "4.1M", presale: { ...KESTREL, decimals: 6 }, tail: "worth $8.6K now" });
  assert.deepEqual(claim?.cta, { kind: "view", label: "View presale", presaleId: KESTREL.presale_id });
  const refund = view({
    kind: "presale_claim", presale: fixturePresale({ lifecycle: "cancelled" }), do_the_same: VIEW(KESTREL.presale_id),
    amounts: { quote: "0", quote_symbol: "USDC", quote_decimals: 6, usd: "250.00", tokens: "0", quote_refund: "250000000" },
  });
  assert.deepEqual([(refund?.body as { amount: string }).amount, (refund?.body as { tail: string }).tail], ["$250", "refund"]);
});

const news = (kind: string, extra: Partial<FeedItem> = {}) =>
  view({ kind, actor: null, amounts: null, why: null, digest: "Ls".padEnd(44, "1"), occurred_at_ms: FIXTURE_NOW - 14 * MIN, ...extra });

test("§3.8 presale posts: each headline and line in the design's words", () => {
  const milestone = news("milestone_participants", { milestone_value: "1000" });
  assert.deepEqual(milestone?.body, { kind: "news", headline: "1,000 people are in", sub: "Meridian passed 1,000 backers with 6 hours left." });
  assert.deepEqual(milestone?.header, { kind: "presale", presale: feedItem().presale });
  assert.equal(milestone?.lead.kind, "presale");
  assert.deepEqual(milestone?.cta, { kind: "commit", label: "Blast" });
  assert.equal(milestone?.followCallsign, null);

  const tidal = fixturePresale({ name: "Tidal", raise_target: "400000000000", raised: "401800000000", participants: 2217 });
  assert.deepEqual(news("milestone_raise", { presale: tidal, milestone_value: "400000000000" })?.body, {
    kind: "news", headline: "Raise target reached", sub: "Tidal passed $400,000. Extra commitments come back pro rata at claim.",
  });
  const funded = fixturePresale({ name: "Cobalt", lifecycle: "funded", venue: "bluefin", raise_target: "250000000000", raised: "312500000000" });
  assert.deepEqual(news("presale_funded", { presale: funded })?.body, {
    kind: "news", headline: "Cobalt is funded", sub: "1.25× oversubscribed. Claims open when the pool launches.",
  });
  const exactly = fixturePresale({ name: "Tidal", lifecycle: "funded", raise_target: "400000000000", raised: "401800000000", participants: 2217 });
  assert.deepEqual(news("presale_funded", { presale: exactly })?.body, {
    kind: "news", headline: "Tidal is funded", sub: "$401,800 from 2,217 people. Trading opens on Cetus when the pool launches.",
  });
  assert.deepEqual(news("presale_migrated", { presale: KESTREL })?.body, {
    kind: "news", headline: "Kestrel is trading on Cetus", sub: "It now trades at 4.2× the presale price. Backers can claim their tokens.",
  });
  assert.deepEqual(news("presale_cancelled", { presale: fixturePresale({ name: "Halcyon", lifecycle: "cancelled", raise_target: "300000000000", raised: "61200000000" }) })?.body, {
    kind: "news", headline: "Halcyon was cancelled", sub: "The target was missed. Everyone can claim a full refund.",
  });
  assert.deepEqual(news("presale_cancelled", { presale: fixturePresale({ name: "Halcyon", lifecycle: "cancelled" , raised: "300000000000" }) })?.body, {
    kind: "news", headline: "Halcyon was cancelled", sub: "It did not launch in time. Everyone can claim a full refund.",
  });
  // Opened: the live design's Create flow words. Holders is not drawn: copy in the same voice.
  assert.deepEqual(news("presale_opened")?.body, { kind: "news", headline: "Meridian is open", sub: "Raising $250K in USDC.", closesAtMs: feedItem().presale!.end_ms });
  assert.deepEqual(news("milestone_holders", { milestone_value: "500" })?.body, { kind: "news", headline: "500 holders", sub: "Meridian passed 500 holders." });
  // A presale post with no indexed presale, an unknown kind, or a person item without an actor: not shown.
  assert.equal(news("presale_funded", { presale: null }), null);
  assert.equal(view({ kind: "launch_buy" }), null);
  assert.equal(view({ actor: null }), null);
});

const backer = (callsign: string, usdValue: string | null = "100.00"): FeedItemBacker => ({
  callsign, display_name: `${callsign[0]!.toUpperCase()}${callsign.slice(1)} X`, avatar_url: null, verified: false, path: `/@${callsign}`, usd: usdValue,
});

test("§3.5 facepile: followed backers first, six faces at most, and the others' count", () => {
  const list = ["luca", "mira", "ana", "nadia", "omar", "theo", "sam"].map((name) => backer(name));
  const visitor = facepile({ list, participants: 1012 }, null);
  assert.deepEqual(visitor.faces.map((face) => face.callsign), ["luca", "mira", "ana", "nadia", "omar", "theo"]);
  assert.deepEqual([visitor.followed, visitor.others], [0, 1012]);
  const followed = facepile({ list, participants: 1012 }, { count: 7, accounts: [backer("sam"), backer("omar"), backer("ivy")] });
  assert.deepEqual(followed.faces.map((face) => face.callsign), ["sam", "omar", "ivy", "luca", "mira", "ana"]);
  assert.deepEqual([followed.followed, followed.others], [7, 1005]);
  // Posts carry their backers only when there are any.
  assert.equal(news("milestone_participants", { milestone_value: "10", backers: [] })?.backers, null);
  assert.deepEqual(news("milestone_participants", { milestone_value: "10", backers: list })?.backers, { presaleId: feedItem().presale!.presale_id, list, participants: 1012 });
});

test("T-021: Add why shows on the viewer's own named item inside 24 h with no why, and nowhere else", () => {
  const own = feedItem({ why: null });
  assert.equal(canAddWhy(own, "mirachen", FIXTURE_NOW), true);
  assert.equal(canAddWhy(own, "kaimoreno", FIXTURE_NOW), false, "someone else's item");
  assert.equal(canAddWhy(own, null, FIXTURE_NOW), false, "a visitor");
  assert.equal(canAddWhy(feedItem(), "mirachen", FIXTURE_NOW), false, "it already has a why");
  assert.equal(canAddWhy(own, "mirachen", own.occurred_at_ms + 24 * HOUR), true, "the 24th hour is inside");
  assert.equal(canAddWhy(own, "mirachen", own.occurred_at_ms + 24 * HOUR + 1), false, "after 24 h");
  assert.equal(canAddWhy({ ...own, kind: "presale_funded", actor: null }, "mirachen", FIXTURE_NOW), false, "a presale's own post");
  assert.equal(canAddWhy({ ...own, kind: "presale_claim" }, "mirachen", FIXTURE_NOW), true, "a claim");
  assert.equal(whyPrompt("presale_commit"), "Why are you in?");
  assert.equal(whyPrompt("presale_claim"), "Your why");
});

test("§3.7 and T-022: the More menu lists the link, the transaction, and one destructive item on a post with a why", () => {
  const items = (item: FeedItem, viewer: string | null) => postMenuItems(postView(item, viewer)!);
  // Someone else's post with a why: the design's "Report post" (`why && !own`).
  assert.deepEqual(items(feedItem(), "kaimoreno"), ["copy-link", "transaction", "report-why"]);
  // A visitor sees it too; the tap goes through the sign-in gate (§0.3).
  assert.deepEqual(items(feedItem(), null), ["copy-link", "transaction", "report-why"]);
  // The viewer's own post with a why: "Delete this why" instead (T-022, an OA-13 addition).
  assert.deepEqual(items(feedItem(), "mirachen"), ["copy-link", "transaction", "delete-why"]);
  // No why, no destructive item; no transaction, no explorer item.
  assert.deepEqual(items(feedItem({ why: null }), "mirachen"), ["copy-link", "transaction"]);
  assert.deepEqual(items(feedItem({ digest: null }), "kaimoreno"), ["copy-link", "report-why"]);
  // A presale's own post has no why to report, whoever reads it.
  assert.deepEqual(items(feedItem({ kind: "presale_funded", actor: null, why: null }), "mirachen"), ["copy-link", "transaction"]);
  // The why the items act on travels with the post.
  assert.equal(postView(feedItem(), "mirachen")?.whyId, "00000000-0000-4000-8000-0000000000aa");
  assert.equal(postView(feedItem({ why: null }), "mirachen")?.whyId, null);
});

test("OA-24: the phone's social-proof line, \"through this post\" or \"through you\"", () => {
  assert.equal(phoneThroughLine(view()!), "6 blasted too through this post · $3.2K");
  assert.equal(phoneThroughLine(view({}, "mirachen")!), "6 blasted too through you · $3.2K");
  assert.equal(phoneThroughLine(view({ through: { people: 1200, volume_usd: "48200.00" } })!), "1,200 blasted too through this post · $48.2K");
  assert.equal(phoneThroughLine(view({ through: { people: 0, volume_usd: "0.00" } })!), null);
});

/**
 * R3-40 in the feed: a post of a SUI-quoted sale reads in SUI where the gate
 * does — the commit (the gate's `qm(s, p.q)`), the opening line (`Raising
 * 100K SUI.`, no "in USDC"), the funded line (`qm(s, s.raised)`), the raise
 * milestone (`passed qm(s, s.target)`) — exactly from the atoms; and in
 * dollars where the gate does: an anonymous big blast (`bigcommit`,
 * `usd(p.usd)`) and a backer's face (`usd(v) in`).
 */
const suiPresale = fixturePresale({ quote_symbol: "SUI", quote_decimals: 9, raise_target: "100000000000000", raised: "99970000000000", participants: 640, quote_usd: "3.42" });
const suiAmounts = { quote: "125000000000", quote_symbol: "SUI", quote_decimals: 9, usd: "427.50", tokens: null, quote_refund: null };

test("R3-40-AC-1: a SUI-quoted post reads in SUI: `BLAST 125 SUI`, `Raising 100K SUI.`, `99,970 SUI from 640 people`, `passed 100,000 SUI`", () => {
  const commit = postView(feedItem({ presale: suiPresale, amounts: suiAmounts }), null);
  assert.equal((commit?.body as { amount: string }).amount, "125 SUI");
  const news = (kind: string, extra: Partial<FeedItem> = {}) =>
    postView(feedItem({ kind, presale: suiPresale, actor: null, amounts: null, why: null, ...extra }), null)?.body as { headline: string; sub: string };
  assert.equal(news("presale_opened").sub, "Raising 100K SUI.");
  assert.equal(news("presale_funded").sub, "99,970 SUI from 640 people. Trading opens on Cetus when the pool launches.");
  assert.equal(news("milestone_raise", { milestone_value: "100000000000000" }).sub, "Myriad passed 100,000 SUI. Extra commitments come back pro rata at claim.".replace("Myriad", suiPresale.name));
  // A refund-only claim of a SUI sale gives the refund in SUI.
  const refund = postView(feedItem({ kind: "presale_claim", presale: { ...suiPresale, lifecycle: "cancelled" }, amounts: { ...suiAmounts, quote: "0", usd: null, quote_refund: "125500000000" } }), null);
  assert.deepEqual([(refund?.body as { amount: string }).amount, (refund?.body as { tail: string }).tail], ["125.5 SUI", "refund"]);
  // The USDC sale beside it is unchanged.
  assert.equal(news("presale_opened", { presale: fixturePresale() }).sub, "Raising $250K in USDC.");
});

test("R3-40: an anonymous wallet's big blast into a SUI sale reads in dollars, the gate's `bigcommit` line", () => {
  const big = postView(feedItem({ presale: suiPresale, amounts: suiAmounts, big: true, actor: { type: "address", address: FIXTURE_ADDRESS, short: "0x1a2b…9f0e" }, why: null }), null);
  assert.equal(big?.context, "big-blast");
  assert.equal((big?.body as { amount: string }).amount, "$428");
});

// ---------- R3-83: trade posts (oa41's `bodyHTML` buy/sell/bigbuy, `ctaFor`, `whyNow`, `bought too`) ----------

const NOW_STORY = FIXTURE_NOW;
const [LUCA_BUY, BIG_BUY, NADIA_BUY, , IVY_BUY, ANA_BUY, SAM_BUY, , THEO_SELL] = tradeStoryItems(NOW_STORY);

test("R3-83-AC-1: a buy reads BUY $8,400 [KSTL] at $0.0019 · now +10.5%, Buy too; the why under it", () => {
  const post = postView(LUCA_BUY!, null, TRADE_STORY_MOVES);
  assert.deepEqual(post?.body, {
    kind: "action", chip: "buy", amount: "$8,400", presale: LUCA_BUY!.presale, tail: "at $0.0019", now: { text: "+10.5%", up: true }, tag: null,
  });
  assert.equal(post?.why, "Intents volume doubled this week. Adding to my presale bag.");
  assert.deepEqual(post?.cta, { kind: "buy", label: "Buy too", presale: LUCA_BUY!.presale });
  assert.equal(post?.context, null);
  // Kestrel is the second gainer; the gate's `Trending · 212 bought today` needs R3-78's counts, so its gain reads.
  assert.equal(post?.whyNow, "Up 18.4% today");
  assert.equal(post?.throughWord, "bought too");
  assert.equal(post?.through, null);
});

test("R3-83-AC-1: a large unnamed buy is a big buy: the wallet, the Big buy tag, Top gainer today, Buy too", () => {
  const post = postView(BIG_BUY!, null, TRADE_STORY_MOVES);
  assert.equal(post?.header.kind, "wallet");
  assert.deepEqual(post?.body, {
    kind: "action", chip: "buy", amount: "$24,800", presale: BIG_BUY!.presale, tail: "at $0.003", now: { text: "+3.3%", up: true }, tag: "big-buy",
  });
  assert.equal(post?.whyNow, "Top gainer today · +32.6%");
  // Big blast is a commit's context; a big buy's is its why-now line.
  assert.equal(post?.context, null);
  assert.deepEqual(post?.cta, { kind: "buy", label: "Buy too", presale: BIG_BUY!.presale });
  // A named big buy and an unnamed small one carry no tag.
  assert.equal((postView({ ...BIG_BUY!, actor: LUCA_BUY!.actor }, null)?.body as { tag: unknown }).tag, null);
  assert.equal((postView({ ...BIG_BUY!, big: false }, null)?.body as { tag: unknown }).tag, null);
});

test("R3-83-AC-1: a sell reads SELL $1,100 [LUMN] at $0.0013 with no move and no why-now line, and View coin", () => {
  const post = postView(THEO_SELL!, null, TRADE_STORY_MOVES);
  assert.deepEqual(post?.body, { kind: "action", chip: "sell", amount: "$1,100", presale: THEO_SELL!.presale, tail: "at $0.0013", now: null, tag: null });
  assert.equal(post?.whyNow, null);
  assert.deepEqual(post?.cta, { kind: "coin", label: "View coin", presaleId: THEO_SELL!.presale!.presale_id });
  // A sell of a coin that moved still shows no move (oa41: `now` only on buys).
  const moved = { ...THEO_SELL!, presale: { ...THEO_SELL!.presale!, market: { ...THEO_SELL!.presale!.market!, price_usd: "0.002" } } };
  assert.equal((postView(moved, null)?.body as { now: unknown }).now, null);
});

test("a trade's price comes from its unrounded dollars; amounts under a dollar read in cents, never $0", () => {
  // $0.0001 for 0.747 tokens (9 decimals) is about $0.000134 each.
  const presale = { ...THEO_SELL!.presale!, decimals: 9 };
  const dust = { ...THEO_SELL!, kind: "trade_buy", presale, amounts: { ...THEO_SELL!.amounts!, usd: "0.0001", tokens: "747000000" } };
  const body = postView(dust, null)?.body as { amount: string; tail: string };
  assert.deepEqual([body.amount, body.tail], ["<$0.01", `at ${px(0.0001 / 0.747)}`]);
  assert.notEqual(body.tail, "at $0");
  const cents = { ...dust, amounts: { ...dust.amounts, usd: "0.3" } };
  assert.equal((postView(cents, null)?.body as { amount: string }).amount, "$0.30");
});

test("R3-83: the move since shows from 0.1 % either way and never without a fresh price", () => {
  // Sam bought Quarry at its price now: no move.
  assert.equal((postView(SAM_BUY!, null)?.body as { now: unknown }).now, null);
  assert.equal((postView(IVY_BUY!, null)?.body as { now: unknown }).now !== null, true);
  const priced = (price: string | null) => ({ ...IVY_BUY!, presale: { ...IVY_BUY!.presale!, market: { ...IVY_BUY!.presale!.market!, price_usd: price } } });
  assert.deepEqual((postView(priced("0.00205"), null)?.body as { now: unknown }).now, null);
  assert.deepEqual((postView(priced("0.0020521"), null)?.body as { now: unknown }).now, { text: "+0.1%", up: true });
  assert.deepEqual((postView(priced("0.001845"), null)?.body as { now: unknown }).now, { text: "−10%", up: false });
  // A stale price is null in the payload (AC-112): no move, never a made-up one.
  assert.equal((postView(priced(null), null)?.body as { now: unknown }).now, null);
});

test("R3-83: why now — Top gainer, Up x% for the next two, nothing past them, nothing without the moves", () => {
  assert.equal(postView(NADIA_BUY!, null, TRADE_STORY_MOVES)?.whyNow, "Top gainer today · +32.6%");
  assert.equal(postView(ANA_BUY!, null, TRADE_STORY_MOVES)?.whyNow, "Up 6.2% today");
  // Quarry is down today: no line.
  assert.equal(postView(SAM_BUY!, null, TRADE_STORY_MOVES)?.whyNow, null);
  // SUI counts among the gainers (the gate's Top coins list it): a fourth gainer gets no line.
  const moves = coinMovesOf(new Map([["sui", 40], [TRADE_STORY_SALES.nimb.id, 32.6], [TRADE_STORY_SALES.kstl.id, 18.4], [TRADE_STORY_SALES.ferr.id, 6.2]]));
  assert.equal(whyNowLine(TRADE_STORY_SALES.nimb.id, moves), "Up 32.6% today");
  assert.equal(whyNowLine(TRADE_STORY_SALES.ferr.id, moves), null);
  assert.equal(whyNowLine(TRADE_STORY_SALES.nimb.id, coinMovesOf(new Map([[TRADE_STORY_SALES.nimb.id, 3]]))), "Top gainer today · +3%");
  // Until the moves are read (or when they fail), no line.
  assert.equal(postView(NADIA_BUY!, null)?.whyNow, null);
  assert.equal(whyNowLine(TRADE_STORY_SALES.nimb.id, null), null);
  // Commits never get one.
  assert.equal(postView(feedItem(), null, TRADE_STORY_MOVES)?.whyNow, null);
});

test("R3-83: your own trade has no call to action; a trade of a sale that does not trade keeps the item's own", () => {
  assert.equal(postView(LUCA_BUY!, "lucaromano", TRADE_STORY_MOVES)?.cta, null);
  assert.equal(postView(THEO_SELL!, "theopark")?.cta, null);
  const pending = { ...LUCA_BUY!, presale: { ...LUCA_BUY!.presale!, lifecycle: "funded" } };
  assert.deepEqual(postView(pending, null)?.cta, { kind: "view", label: "View presale", presaleId: LUCA_BUY!.presale!.presale_id });
});

test("R3-83: people who bought through a trade post read `bought too`, on phones too; commits keep `blasted too`", () => {
  const through = postView({ ...ANA_BUY!, through: { people: 2, volume_usd: "640.00" } }, null);
  assert.deepEqual(through?.through, { people: 2, volume: "$640" });
  assert.equal(through?.throughWord, "bought too");
  assert.equal(phoneThroughLine(through!), "2 bought too through this post · $640");
  assert.equal(postView(feedItem(), null)?.throughWord, "blasted too");
});

test("R3-83: pct1 is the prototype's one-place signed move", () => {
  for (const [value, text] of [[10.526, "+10.5%"], [32.6, "+32.6%"], [3, "+3%"], [-3.1, "−3.1%"], [0, "+0%"], [-0.04, "−0%"]] as const) assert.equal(pct1(value), text, String(value));
});


test("creation announcements are hidden and the opening announcement remains", () => {
  assert.equal(news("presale_created"), null);
  assert.equal(news("presale_created", { presale: fixturePresale({ lifecycle: "pending" }) }), null);
  assert.equal(news("presale_opened")?.body.kind, "news");
});
