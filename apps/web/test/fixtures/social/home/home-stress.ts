import type { FeedItemActor } from "@blast/core/modules/social/contracts/items.ts";
import type { CoinHomeProps } from "#web/components/social/coin-home/CoinHome.tsx";
import type {
  HomeCoin,
  HomeParticipant,
  HomeTrader,
} from "@blast/core/modules/social/contracts/home.ts";

export const HOME_STRESS_STATES = [
  "demo",
  "worst",
  "empty",
  "one",
  "max",
] as const;
export type HomeStressState = (typeof HOME_STRESS_STATES)[number];

// Imported token metadata has no name/symbol maximum in the Home API contract.
// Accounts still respect the server's 32-code-point name / 20-character handle limits.
const identities = [
  [
    "WrappedStakedInstitutionalSUI",
    "Wrapped Staked Institutional Sui Treasury",
  ],
  ["社区共建生态基金", "社区共建生态基金 · Nguyễn Thị Minh"],
  ["J", "Jo"],
  ["🚀MOON", "Moon & Stars <Community>"],
  ["BRIDGE_USDC", "Bridged USD Coin (Wormhole Portal)"],
] as const;
const names = [
  "Aleksandra Wiśniewska-Kowalczyk",
  "Nguyễn Thị Minh Phương",
  "Jo",
  "👩🏽‍🚀 Amara",
  "社区生态基金",
];
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function actorAt(index: number): FeedItemActor {
  const callsign = index === 0 ? "aleksandra_wisniewsk" : `reader_${index}`;
  return {
    type: "account",
    callsign,
    display_name: names[index % names.length]!,
    avatar_url: null,
    x_handle: null,
    verified: false,
    path: `/@${callsign}`,
  };
}

function stressCoin(base: HomeCoin, index: number, now: number): HomeCoin {
  const [symbol, name] = identities[index % identities.length]!;
  const missing = index % 5 === 2;
  return {
    ...base,
    presale_id: id(index + (base.lifecycle === "migrated" ? 100 : 200)),
    coin_type: `${id(index + 300)}::treasury::TREASURY`,
    symbol,
    name,
    icon_url: null,
    price_usd: priceAt(index),
    price_as_of_ms: missing ? null : now - 180_000,
    change_24h_bps: missing ? null : index % 2 ? -9999 : 1234567,
    fdv_usd: missing ? null : "1234567890123.45",
    holders: missing ? null : 1_284_567,
    launched_ms: missing ? null : now - (index % 2 ? 5_000 : 366 * 86_400_000),
    spark: [],
    activity: {
      ...base.activity,
      preview: [stressParticipant(base, index, now)],
    },
    sale: saleAt(base.sale, index, now),
    quote: {
      ...base.quote,
      symbol: index === 0 ? "WrappedStakedSUI" : base.quote.symbol,
    },
    top_holders: {
      share_bps: missing ? null : 9999,
      holders: [
        {
          actor: actorAt(index),
          balance: "18446744073709551615",
          share_bps: missing ? null : 9999,
        },
      ],
    },
  };
}

function priceAt(index: number): string | null {
  if (index % 5 === 2) return null;
  return index % 5 === 1 ? "0.000000000123" : "1234567.89";
}

function saleAt(sale: HomeCoin["sale"], index: number, now: number): HomeCoin["sale"] {
  if (!sale) return null;
  return {
    ...sale,
    start_ms: now - 86_400_000,
    end_ms: now + 76_000,
    participants: index % 5 === 2 ? 1 : 1_284_567,
    raised: index % 5 === 2 ? "0" : "18446744073709551615",
    raise_target: "12999999999999999999",
  };
}

function singleParticipantCoin(coin: HomeCoin): HomeCoin {
  return {
    ...coin,
    holders: 1,
    sale: coin.sale ? { ...coin.sale, participants: 1 } : null,
    discussion: { posts: 1 },
    activity: {
      ...coin.activity,
      participants: 1,
      events: 1,
      buyers: coin.lifecycle === "migrated" ? 1 : 0,
      sellers: 0,
      backers: coin.lifecycle === "open" ? 1 : 0,
      claimers: 0,
    },
  };
}

function stressParticipant(
  coin: HomeCoin,
  index: number,
  now: number,
): HomeParticipant {
  const actor = actorAt(index);
  const kind = coin.lifecycle === "migrated" ? "trade_buy" : "presale_commit";
  const quote = {
    quote_type: coin.quote.type,
    quote_symbol: "WrappedStakedSUI",
    quote_decimals: 9,
    atoms: "18446744073709551615",
    usd: null,
    usd_complete: false,
  };
  return {
    key: `c:${index}`,
    actor,
    followers: 1_284,
    buys: null,
    sells: null,
    commits: null,
    claims: null,
    latest_ms: now - 1_000,
    latest_kind: kind,
    events_total: 1,
    events: [
      {
        activity_id: `${9000 + index}:0:0:0`,
        entry_id: `a:${9000 + index}:0:0:0`,
        kind,
        occurred_at_ms: now - 1_000,
        digest: null,
        quote,
        tokens: "18446744073709551615",
        refund: null,
        has_why: true,
      },
    ],
  };
}

function traderAt(
  coins: readonly HomeCoin[],
  index: number,
  now: number,
): HomeTrader {
  const actor = actorAt(index);
  return {
    key: `c:${actor.type === "account" ? actor.callsign : index}`,
    actor,
    followers: index === 2 ? null : 1_284,
    buys: null,
    sells: null,
    commits: null,
    claims: null,
    latest_ms: now - 1_000,
    latest_kind: "trade_buy",
    events_total: 1,
    rank: index + 1,
    portfolio: {
      public: true,
      value_usd: "1234567890123.45",
      pnl_usd: index % 2 ? "-1234567890123.45" : "1234567890123.45",
    },
    holdings: coins.slice(0, 3).map((coin, j) => ({
      presale_id: coin.presale_id!,
      symbol: coin.symbol,
      icon_url: null,
      decimals: coin.decimals,
      balance: "18446744073709551615",
      value_usd: index === 3 ? null : "1234567890123.45",
      share_bps: index === 3 ? null : [5000, 3000, 2000][j]!,
      pnl_usd: index === 3 ? null : "-0.01",
    })),
    coins: [],
    coins_total: 1,
  };
}

/** Dev/test data only. The same typed props as the server's Home read, never a production route. */
export function homeStressProps(
  demo: CoinHomeProps,
  state: HomeStressState,
): CoinHomeProps {
  if (state === "demo") return demo;
  // Trending lists sales among the coins, so the demo's own sale rows seed the stressed ones.
  const saleSeeds = demo.initial?.coins.filter((coin) => coin.sale) ?? [];
  if (
    !demo.initial?.coins.length ||
    !saleSeeds.length ||
    !demo.posts?.items.length
  )
    throw new Error(
      "Home stress data needs one trading coin, presale and post",
    );
  const count = { empty: 0, one: 1, max: 50, worst: 5 }[state];
  const coins = Array.from({ length: count }, (_, i) =>
    stressCoin(
      demo.initial!.coins[i % demo.initial!.coins.length]!,
      i,
      demo.nowMs,
    ),
  );
  const sales = Array.from({ length: count }, (_, i) =>
    stressCoin(saleSeeds[i % saleSeeds.length]!, i + count, demo.nowMs),
  );
  if (state === "one") {
    for (const collection of [coins, sales]) {
      collection[0] = singleParticipantCoin(collection[0]!);
    }
  }
  const items = Array.from({ length: Math.min(count, 20) }, (_, i) => {
    const base = demo.posts!.items[i % demo.posts!.items.length]!;
    const coin = [...sales, ...coins][i % Math.max(1, count)]!;
    return {
      ...base,
      entry_id: `a:${9000 + i}:0:0:0`,
      actor: i === 1 ? null : actorAt(i),
      occurred_at_ms:
        demo.nowMs - (i === 0 ? 1_000 : i === 1 ? 366 * 86_400_000 : 60_000),
      presale: base.presale
        ? {
            ...base.presale,
            presale_id: coin.presale_id!,
            symbol: coin.symbol,
            name: coin.name,
          }
        : null,
      why:
        i === 2
          ? null
          : {
              why_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
              text: "https://research.community.example/treasury/InstitutionalWrappedStakedSuiQuarterlyTransparencyReport — 社区共建生态基金. <b>Community owned</b> & independently audited.",
            },
    };
  });
  return {
    ...demo,
    initialRows: state === "max" ? 20 : 5,
    initial: {
      ...demo.initial,
      coins: coins.flatMap((coin, i) => [coin, sales[i]!]).slice(0, state === "max" ? 20 : 5),
      page: 1,
      pages: state === "max" ? 9999 : 1,
      total: state === "max" ? 199_980 : count * 2,
      next_cursor: null,
    },
    traders: {
      ...demo.traders!,
      traders: coins.slice(0, 10).map((_, i) => traderAt(coins, i, demo.nowMs)),
    },
    posts: {
      ...demo.posts,
      items,
      next_cursor: state === "max" ? demo.posts.next_cursor : null,
    },
  };
}
