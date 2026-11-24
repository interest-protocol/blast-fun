import assert from "node:assert/strict";
import test from "node:test";

import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import type {
  SocialRewardCoin,
  SocialRewardPayout,
} from "@blast/core/modules/social/contracts/rewards.ts";

import {
  amountsText,
  coinSub,
  coinTotalText,
  coinValue,
  grandText,
  moreText,
  payoutLabel,
  payoutSub,
  payoutToast,
  quoteText,
  relayOwed,
  rewardCoinMeta,
  rewardCoins,
  rewardPayouts,
  rewardsTabSum,
  waitReason,
  whenText,
} from "./rewards-model";
import { REWARDS_FIXTURE_NOW, rewardsFixture } from "../../../../test/fixtures/social/rewards/rewards-fixture.ts";
import { newPayouts } from "./use-rewards";
import { isRewardsPage } from "./rewards-client";

/** OA-45, OA-46: Rewards' strings against the gate's (oa46 `rwWhen`, `rwQuote`, `rwAmts`, `rwGrandTxt`, `rwCoinHTML`, `rwTabSum`). */

const KSTL = `0x${"a".repeat(64)}`;
const LUMN = `0x${"b".repeat(64)}`;
const USDC = "0xdba3::usdc::USDC";
const NOW = Date.UTC(2026, 9, 3, 18, 0, 0);

const coin = (
  sourceId: string,
  symbol: string,
  over: Partial<SocialRewardCoin> = {},
): SocialRewardCoin => ({
  presale_id: sourceId,
  name: symbol === "KSTL" ? "Kestrel" : "Lumen",
  symbol,
  icon_url: "",
  sale_decimals: 9,
  quote_type: USDC,
  quote_symbol: "USDC",
  quote_decimals: 6,
  rounds: 12,
  payouts: 12,
  received: { meme: "16206000000000", quote: "38430000" },
  last_payout_ms: NOW - 6 * 3_600_000,
  waiting: null,
  ...over,
});
const price = (usd: string | null) =>
  ({ price_usd: usd }) as SocialPriceHistory;

test("OA-45: times, quotes and both parts read as the gate's", () => {
  assert.equal(whenText(NOW - 10_000, NOW), "just now");
  assert.equal(whenText(NOW - 6 * 60_000, NOW), "6 min ago");
  assert.equal(whenText(NOW - 18 * 3_600_000, NOW), "18 h ago");
  assert.equal(whenText(NOW - 2 * 86_400_000, NOW), "2 d ago");
  assert.equal(quoteText(2.1, "USDC"), "$2.10 USDC");
  assert.equal(quoteText(0.4249, "SUI"), "0.42 SUI");
  assert.equal(
    amountsText({ coin: 1254, quote: 2.1 }, "KSTL", "USDC"),
    "+1,254 KSTL · +$2.10 USDC",
  );
  assert.equal(waitReason("next"), "Queued for automatic delivery");
  assert.equal(
    waitReason("unpayable"),
    "Couldn’t be sent automatically. Claim it yourself.",
  );
  assert.equal(moreText(7), "Load more payouts (7)");
  assert.equal(moreText(23), "Load more payouts (10)");
});

test("OA-45: a dollar figure only where the coin's and its quote's prices are both known", () => {
  const coins = [
    coin(KSTL, "KSTL"),
    coin(LUMN, "LUMN", {
      payouts: 7,
      rounds: 28,
      received: { meme: "1642000000000", quote: "2130000" },
      last_payout_ms: NOW - 86_400_000,
    }),
  ];
  const both = rewardCoins(
    coins,
    new Map([
      [KSTL, price("0.0021")],
      [LUMN, price("0.0013")],
      [USDC, price("1")],
    ]),
  );
  assert.equal(grandText(both), "≈ $76.73");
  assert.equal(rewardsTabSum(both, false), "≈ $76.73 received");
  assert.equal(rewardsTabSum(both, true), "•••• received");
  // Lumen's coin price unknown: its symbol rides along.
  const partial = rewardCoins(
    coins,
    new Map([
      [KSTL, price("0.0021")],
      [USDC, price("1")],
    ]),
  );
  assert.equal(grandText(partial), "≈ $72.46 · +1,642 LUMN · +$2.13 USDC");
  // No quote price: no dollar figure at all, every coin's amounts instead.
  const none = rewardCoins(
    coins,
    new Map([
      [KSTL, price("0.0021")],
      [LUMN, price("0.0013")],
    ]),
  );
  assert.equal(
    grandText(none),
    "+16,206 KSTL · +$38.43 USDC · +1,642 LUMN · +$2.13 USDC",
  );
  assert.deepEqual(coinValue(none[0]!, false), {
    top: "+16,206 KSTL · +$38.43 USDC",
    bottom: "",
  });
  assert.deepEqual(coinValue(both[0]!, false), {
    top: "+16,206 KSTL · +$38.43 USDC",
    bottom: "≈ $72.46",
  });
  assert.deepEqual(coinValue(both[0]!, true), { top: "••••", bottom: "••••" });
  assert.equal(
    coinTotalText(both[1]!, false),
    "Received +1,642 LUMN · +$2.13 USDC",
  );
  assert.equal(rewardsTabSum([], false), "");
  assert.equal(rewardsTabSum(null, false), "");
});

test("OA-46: a coin's line counts rounds, and payouts only when not every round paid; without a round count, payouts alone", () => {
  const [kstl, lumn, unknown] = rewardCoins(
    [
      coin(KSTL, "KSTL"),
      coin(LUMN, "LUMN", {
        payouts: 7,
        rounds: 28,
        last_payout_ms: NOW - 86_400_000,
      }),
      coin(`0x${"c".repeat(64)}`, "CBLT", {
        rounds: null,
        payouts: 1,
        last_payout_ms: NOW - 2 * 86_400_000,
      }),
    ],
    new Map(),
  );
  assert.equal(coinSub(kstl!, NOW), "Last 6 h ago · 12 payouts");
  assert.equal(coinSub(lumn!, NOW), "Last 1 d ago · 7 payouts · 28 rounds");
  assert.equal(coinSub(unknown!, NOW), "Last 2 d ago · 1 payout");
});

test("OA-45: paid and waiting coins are drawn; owed amounts split by delivery", () => {
  const coins = rewardCoins(
    [
      coin(KSTL, "KSTL", {
        waiting: {
          next: { meme: "410000000000", quote: "1020000" },
          unpayable: { meme: "0", quote: "0" },
        },
      }),
      coin(LUMN, "LUMN", {
        payouts: 0,
        last_payout_ms: null,
        received: { meme: "0", quote: "0" },
        waiting: { next: { meme: "1", quote: "0" }, unpayable: null },
      }),
    ],
    new Map(),
  );
  assert.deepEqual(
    coins.map((c) => c.symbol),
    ["KSTL", "LUMN"],
  );
  // A zero share draws no line.
  assert.deepEqual(coins[0]!.waiting, {
    next: { coin: 410, quote: 1.02, exactCoin: "410", exactQuote: "1.02" },
    unpayable: null,
  });
  assert.equal(relayOwed(coins), true);
  assert.equal(relayOwed(rewardCoins([coin(KSTL, "KSTL")], new Map())), false);
});

test("OA-46: a payout row names who delivered it only when the wallet claimed it; its round is the ordinal (the chain counts from 0)", () => {
  const meta = rewardCoinMeta([coin(KSTL, "KSTL")]);
  const row = (over: Partial<SocialRewardPayout>): SocialRewardPayout => ({
    presale_id: KSTL,
    round_id: `0x${"e".repeat(64)}`,
    round_number: "11",
    meme_amount: "1254000000000",
    quote_amount: "2100000",
    digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    timestamp_ms: NOW - 6 * 3_600_000,
    relayed_by: "0x1",
    self_claimed: false,
    ...over,
  });
  const [sent, self, orphan] = rewardPayouts(
    [
      row({}),
      row({ self_claimed: true, round_number: "17" }),
      row({ presale_id: LUMN }),
    ],
    meta,
  );
  assert.equal(orphan, undefined);
  assert.equal(sent!.round, 12);
  assert.equal(payoutSub(sent!, NOW), "6 h ago");
  assert.equal(payoutSub(self!, NOW), "6 h ago · Claimed by your wallet");
  assert.equal(
    payoutLabel(sent!, NOW, false, "Suiscan"),
    "Kestrel, round 12: 1,254 KSTL · 2.1 USDC, 6 h ago. Sent by Blast. Opens the transaction on Suiscan",
  );
  assert.equal(
    payoutLabel(self!, NOW, true, "SuiVision"),
    "Kestrel, round 18: ••••, 6 h ago. Claimed by your wallet. Opens the transaction on SuiVision",
  );
  assert.deepEqual(payoutToast(sent!), {
    title: "You received rewards from KSTL",
    sub: "+1,254 KSTL · +$2.10 USDC · Round 12",
  });
});

test("OA-45: the toast announces only payouts newer than this device last saw, and nothing on a first read", () => {
  const meta = rewardCoinMeta([coin(KSTL, "KSTL")]);
  const latest = rewardPayouts(
    [3, 2, 1].map((n) => ({
      presale_id: KSTL,
      round_id: `0x${String(n).repeat(64)}`,
      round_number: String(n),
      meme_amount: "1",
      quote_amount: "1",
      digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      timestamp_ms: NOW - (10 - n) * 60_000,
      relayed_by: "0x1",
      self_claimed: false,
    })),
    meta,
  );
  assert.deepEqual(newPayouts(latest, undefined), []);
  assert.deepEqual(
    newPayouts(latest, NOW - 8 * 60_000).map((p) => p.round),
    [4],
  );
  assert.deepEqual(
    newPayouts(latest, 0).map((p) => p.round),
    [4, 3, 2],
  );
  assert.deepEqual(newPayouts(latest, NOW), []);
});

test("canonical daily fixture queues positive quote-only shares without a delivery threshold", () => {
  const fixture = rewardsFixture("ready");
  assert.equal(fixture.nowMs, REWARDS_FIXTURE_NOW);
  assert.equal(grandText(fixture.coins), "≈ $21.23");
  assert.deepEqual(
    fixture.coins.map((c) => [c.rounds, c.payouts]),
    [
      [6, 6],
      [14, 12],
    ],
  );
  assert.ok(
    fixture.coins.every(
      (c) => c.received.coin === 0 && c.waiting.next !== null,
    ),
  );
  assert.ok(
    fixture.latest.every((p) => p.amounts.coin === 0 && p.amounts.quote > 0),
  );
  assert.equal(rewardsFixture("empty").coins.length, 0);
});

test("quote-only rewards use quote prices and amounts when the sale token has no price", () => {
  const [view] = rewardCoins(
    [coin(KSTL, "KSTL", { received: { meme: "0", quote: "1250000" } })],
    new Map([[USDC, price("1")]]),
  );
  assert.equal(view!.usd, 1.25);
  assert.equal(amountsText(view!.received, "KSTL", "USDC"), "+$1.25 USDC");
  assert.deepEqual(coinValue(view!, false), {
    top: "+$1.25 USDC",
    bottom: "≈ $1.25",
  });
});

test("canonical rewards responses accept queued tiny payouts and reject the retired dust category", () => {
  const queued = { next: { meme: "0", quote: "1" }, unpayable: null };
  const page = {
    coins: [coin(KSTL, "KSTL", { waiting: queued })],
    payouts: [],
    next_cursor: null,
  };
  assert.equal(isRewardsPage(page), true);
  assert.equal(
    isRewardsPage({
      ...page,
      coins: [{ ...page.coins[0], waiting: { ...queued, dust: null } }],
    }),
    false,
  );
});


test("standalone rewards validate and retain independent vault identities", () => {
  const a = `0x${"c".repeat(64)}`, b = `0x${"d".repeat(64)}`;
  const coins = [a,b].map((id)=>coin(id,"SOLO",{presale_id:null,vault_id:id,source_id:id}));
  const page = {coins,payouts:[],next_cursor:null};
  assert.equal(isRewardsPage(page),true);
  assert.deepEqual(rewardCoins(coins,new Map()).map((coin)=>coin.sourceId),[a,b]);
  assert.equal(rewardCoinMeta(coins).get(a)?.vaultId,a);
  assert.equal(isRewardsPage({...page,coins:[{...coins[0],source_id:b}]}),false);
  assert.equal(isRewardsPage({...page,coins:[{...coins[0],vault_id:undefined}]}),false);
});


test("tiny nonzero rewards retain token quantities and exact accessible amounts", () => {
  const [view] = rewardCoins([coin(KSTL, "KSTL", { received: { meme: "1", quote: "1" } })], new Map([[KSTL, price("1")], [USDC, price("1")]]));
  assert.equal(amountsText(view!.received, "KSTL", "USDC"), "+<0.01 KSTL · +<$0.01 USDC");
  assert.equal(grandText([view!]), "≈ <$0.01");
  assert.equal(view!.received.exactCoin, "0.000000001");
  assert.equal(view!.received.exactQuote, "0.000001");
  assert.equal(amountsText({ coin: 0, quote: 0 }, "KSTL", "SUI"), "+0 SUI");
});
