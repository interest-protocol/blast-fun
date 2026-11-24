import type { SocialPriceHistory } from "@blast/core/modules/social/contracts/prices.ts";
import type {
  SocialRewardCoin,
  SocialRewardPayout,
  SocialRewardsPage,
} from "@blast/core/modules/social/contracts/rewards.ts";

import { FIXTURE_MARKS } from "../profile/fixture-media.ts";
import {
  rewardCoinMeta,
  rewardPayouts,
  rewardSourceId,
  rewardsView,
  type RewardPayoutView,
} from "#web/components/social/rewards/rewards-model.ts";

/**
 * Development only (the Portfolio and Rewards fixtures, never shipped): the
 * gate's sample payouts for Kai's wallet (`seedRewards` in
 * `design/blast-trading-home-oa46.html`), shaped as `GET
 * /api/social/me/rewards` answers, so the pixel comparison draws the same
 * rows. Positive shares enter automatic delivery, including small shares;
 * one payout was claimed by the wallet itself.
 * The gate's amounts come from its own seeded generator, reproduced here.
 */

/** The gate's harness clock (Oct 3, 18:00 UTC): the sample's rounds are daily fixture slots, so they need the absolute time. */
export const REWARDS_FIXTURE_NOW = Date.UTC(2026, 9, 3, 18, 0, 0);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REWARD_ROUND_MS = DAY;
const MIN = 60_000;
const id = (tag: string) => `0x${tag.padStart(64, "0")}`;
const USDC_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

type Plan = Readonly<{
  key: "kstl" | "lumn";
  name: string;
  symbol: string;
  launchedAgo: number;
  every: number;
  lag: number;
  coin: [number, number];
  quote: [number, number];
}>;
const PLANS: readonly Plan[] = [
  {
    key: "kstl",
    name: "Kestrel",
    symbol: "KSTL",
    launchedAgo: 6 * DAY,
    every: 1,
    lag: 0,
    coin: [880, 1640],
    quote: [2.1, 4.2],
  },
  {
    key: "lumn",
    name: "Lumen",
    symbol: "LUMN",
    launchedAgo: 14 * DAY,
    every: 1,
    lag: 2,
    coin: [160, 260],
    quote: [0.21, 0.38],
  },
];

const hsh = (key: string) =>
  [...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
const digestOf = (seed: number) =>
  Array.from(
    { length: 44 },
    (_, i) => B58[(seed * 7 + i * 13 + ((seed >>> i % 16) & 7)) % 58],
  ).join("");
const atoms = (value: number, decimals: number) =>
  BigInt(Math.round(value * 10 ** decimals)).toString();

function build(nowMs: number) {
  const at0 = Math.floor(nowMs / REWARD_ROUND_MS) * REWARD_ROUND_MS;
  const coins: SocialRewardCoin[] = [];
  const payouts: SocialRewardPayout[] = [];
  for (const plan of PLANS) {
    const sourceId = id(plan.key);
    const rounds =
      Math.floor((at0 - (nowMs - plan.launchedAgo)) / REWARD_ROUND_MS) + 1;
    let h = hsh(plan.key);
    const rnd = ([a, b]: [number, number]) => {
      h = (h * 1103515245 + 12345) >>> 0;
      return a + ((h % 1000) / 1000) * (b - a);
    };
    const own: SocialRewardPayout[] = [];
    for (let r = rounds - plan.lag; r >= 1; r -= plan.every) {
      const roundAt = at0 - (rounds - r) * REWARD_ROUND_MS;
      rnd(plan.coin); // Preserve deterministic quote values in the fixture.
      const coin = 0;
      const quote = Math.round(rnd(plan.quote) * 100) / 100;
      const self =
        plan.key === "lumn" && r === rounds - plan.lag - 2 * plan.every;
      own.push({
        presale_id: sourceId,
        round_id: id(`${plan.key}${r}`.replace(/[^0-9a-f]/g, "e")),
        round_number: String(r - 1),
        meme_amount: atoms(coin, 9),
        quote_amount: atoms(quote, 6),
        digest: digestOf(hsh(`${plan.key}:${r}`)),
        timestamp_ms: roundAt + (4 + (h % 9)) * MIN,
        relayed_by: self ? id("ca1") : id("b1a57"),
        self_claimed: self,
      });
    }
    payouts.push(...own);
    const sum = (pick: (row: SocialRewardPayout) => string) =>
      own.reduce((total, row) => total + BigInt(pick(row)), 0n).toString();
    const lastPaid = rounds - plan.lag;
    coins.push({
      presale_id: sourceId,
      name: plan.name,
      symbol: plan.symbol,
      icon_url: FIXTURE_MARKS[plan.key] ?? "",
      sale_decimals: 9,
      quote_type: USDC_TYPE,
      quote_symbol: "USDC",
      quote_decimals: 6,
      rounds,
      payouts: own.length,
      received: {
        meme: sum((row) => row.meme_amount),
        quote: sum((row) => row.quote_amount),
      },
      last_payout_ms: Math.max(...own.map((row) => row.timestamp_ms)),
      // The open rounds: Kestrel's share goes out with the next payout; Lumen's is also queued.
      waiting:
        plan.key === "kstl"
          ? {
              next: { meme: "0", quote: atoms(1.02, 6) },
              unpayable: null,
            }
          : {
              next: {
                meme: "0",
                quote: atoms(
                  Math.round(0.07 * (rounds - lastPaid) * 100) / 100,
                  6,
                ),
              },
              unpayable: null,
            },
    });
  }
  payouts.sort((a, b) => b.timestamp_ms - a.timestamp_ms);
  coins.sort((a, b) => (b.last_payout_ms ?? 0) - (a.last_payout_ms ?? 0));
  return { coins, payouts };
}

/** Today's prices as the gate has them: KSTL $0.0021, LUMN $0.0013, USDC $1 (R3-20's shape, the price now only). */
function price(
  sourceId: string | null,
  coinType: string,
  usd: number,
): SocialPriceHistory {
  return {
    presale_id: sourceId,
    coin_type: coinType,
    tier: "5m",
    from_ms: REWARDS_FIXTURE_NOW - DAY,
    points: [],
    price_usd: String(usd),
    price_24h_usd: null,
    change_24h_bps: null,
    day_open_usd: null,
    day_open_ms: null,
  };
}
const PRICES = new Map<string, SocialPriceHistory | null>([
  [id("kstl"), price(id("kstl"), `${id("kstl")}::kstl::KSTL`, 0.0021)],
  [id("lumn"), price(id("lumn"), `${id("lumn")}::lumn::LUMN`, 0.0013)],
  [USDC_TYPE, price(null, USDC_TYPE, 1)],
]);

export type RewardsFixtureState = "ready" | "loading" | "failed" | "empty";

/** The sample as the tab, the page and the side card draw it, in one of the read's states (`?rewards=`). */
export function rewardsFixture(
  state: RewardsFixtureState,
  prices: "sample" | "none" = "sample",
) {
  const sample = build(REWARDS_FIXTURE_NOW);
  const page: SocialRewardsPage =
    state === "empty"
      ? { coins: [], payouts: [], next_cursor: null }
      : {
          coins: sample.coins,
          payouts: sample.payouts.slice(0, 5),
          next_cursor: null,
        };
  const view = rewardsView(page, prices === "none" ? new Map() : PRICES);
  const meta = rewardCoinMeta(sample.coins);
  const byCoin = new Map<string, readonly RewardPayoutView[]>(
    sample.coins.map((coin) => [
      rewardSourceId(coin),
      rewardPayouts(
        sample.payouts.filter((row) => rewardSourceId(row) === rewardSourceId(coin)),
        meta,
      ),
    ]),
  );
  const status =
    state === "loading"
      ? ("loading" as const)
      : state === "failed"
        ? ("error" as const)
        : ("ready" as const);
  return {
    status,
    coins: view.coins,
    latest: view.latest,
    byCoin,
    nowMs: REWARDS_FIXTURE_NOW,
  };
}
