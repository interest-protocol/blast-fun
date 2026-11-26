import { atomsGrouped, atomsValue, HIDDEN_AMOUNT, qty, usd } from "@blast/core/web/format.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import type {
  RewardAmounts,
  SocialRewardCoin,
  SocialRewardPayout,
  SocialRewardsPage,
} from "@blast/core/web/contracts/rewards.ts";

/**
 * Rewards' view model (OA-45, OA-46; the gate is
 * `design/blast-trading-home-oa46.html`, the layer "Rewards: holders' share
 * of each launched coin's LP fees"): pure functions from `GET
 * /api/social/me/rewards` and R3-20's prices to the strings the tab, the
 * page and the side card draw.
 *
 * Only what the read returns is shown: coin, round, coin amount, quote
 * amount, time, digest, and whether the wallet claimed it itself. A dollar
 * figure appears only where today's price of the coin and of its quote coin
 * is known (R3-20's `price_usd`); otherwise the amounts stand alone.
 */

/** A coin's rounds on the page: five, then ten more at a time. */
export const RW_PAGE_N = 5;
export const RW_MORE = 10;

export type RewardAmountsView = Readonly<{ coin: number; quote: number; exactCoin?: string; exactQuote?: string }>;

/** Why a share waits (the reward relay's `WaitReason`). */
export type WaitKind = "next" | "unpayable";
export const WAIT_KINDS: readonly WaitKind[] = ["next", "unpayable"];

/** A coin that paid the viewer, with its totals in whole units and (when both prices are known) dollars. */
export type RewardCoinView = Readonly<{
  sourceId: string;
  name: string;
  symbol: string;
  iconUrl: string | null;
  quoteSymbol: string;
  /** Published rounds, or null when the web records none (then only payouts are counted). */
  rounds: number | null;
  payouts: number;
  received: RewardAmountsView;
  /** Received at today's prices; null unless the coin's and its quote's prices are both known. */
  usd: number | null;
  lastMs: number;
  /** Unpaid, by why it waits (the reward relay's record): `next` is queued for automatic delivery; `unpayable` is set aside after delivery failures. */
  waiting: Readonly<Record<WaitKind, RewardAmountsView | null>>;
}>;

/** One payout, with its coin. `round` is the round's ordinal (the chain numbers a coin's first round 0). */
export type RewardPayoutView = Readonly<{
  key: string;
  sourceId: string;
  name: string;
  symbol: string;
  iconUrl: string | null;
  quoteSymbol: string;
  round: number;
  amounts: RewardAmountsView;
  atMs: number;
  digest: string;
  selfClaimed: boolean;
}>;

/** The coin metadata a payout needs to be drawn (a payout of a coin the summary does not list is not drawn). */
type CoinMeta = Readonly<{
  name: string;
  symbol: string;
  iconUrl: string | null;
  saleDecimals: number;
  quoteSymbol: string;
  quoteDecimals: number;
  vaultId?: string;
}>;

export type RewardCoinMeta = ReadonlyMap<string, CoinMeta>;

/** Atoms as whole units (display only). */
const units = (atoms: string, decimals: number): number => atomsValue(atoms, decimals) ?? 0;

function metaOf(coin: SocialRewardCoin): CoinMeta {
  return {
    name: coin.name,
    symbol: coin.symbol,
    iconUrl: coin.icon_url || null,
    saleDecimals: coin.sale_decimals,
    quoteSymbol: coin.quote_symbol,
    quoteDecimals: coin.quote_decimals,
    ...(coin.presale_id === null ? { vaultId: coin.vault_id } : {}),
  };
}

export function rewardSourceId(source: Pick<SocialRewardCoin, "presale_id" | "vault_id" | "source_id">): string {
  const id = source.source_id ?? source.presale_id ?? source.vault_id;
  if (!id) throw new Error("Reward source identity is missing.");
  return id;
}

/** Each coin's metadata from a summary page, by sale. */
export function rewardCoinMeta(
  coins: readonly SocialRewardCoin[] | null,
): RewardCoinMeta {
  const out = new Map<string, CoinMeta>();
  for (const coin of coins ?? []) out.set(rewardSourceId(coin), metaOf(coin));
  return out;
}

/** A price from R3-20's read, as a number; null when it is unknown, still reading, or not a positive number. */
export function priceUsd(
  price: SocialPriceHistory | null | undefined,
): number | null {
  const value = price?.price_usd == null ? Number.NaN : Number(price.price_usd);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function amountsOf(
  meta: CoinMeta,
  amounts: RewardAmounts | null,
): RewardAmountsView | null {
  if (!amounts) return null;
  const view = {
    coin: units(amounts.meme, meta.saleDecimals),
    exactCoin: atomsGrouped(BigInt(amounts.meme), meta.saleDecimals),
    exactQuote: atomsGrouped(BigInt(amounts.quote), meta.quoteDecimals),
    quote: units(amounts.quote, meta.quoteDecimals),
  };
  return view.coin > 0 || view.quote > 0 ? view : null;
}

/**
 * The coins that paid the viewer, latest payout first (the gate's
 * `rwCoins`), each with its totals. `prices` is R3-20's read by sale id (the
 * coin) and by quote coin type.
 */
export function rewardCoins(
  coins: readonly SocialRewardCoin[] | null,
  prices: ReadonlyMap<string, SocialPriceHistory | null | undefined>,
): readonly RewardCoinView[] {
  const out: RewardCoinView[] = [];
  for (const coin of coins ?? []) {
    const meta = metaOf(coin);
    if (coin.payouts === 0 && !coin.waiting?.next && !coin.waiting?.unpayable) continue;
    const received = {
      coin: units(coin.received.meme, meta.saleDecimals),
      exactCoin: atomsGrouped(BigInt(coin.received.meme), meta.saleDecimals),
      exactQuote: atomsGrouped(BigInt(coin.received.quote), meta.quoteDecimals),
      quote: units(coin.received.quote, meta.quoteDecimals),
    };
    const coinPx = priceUsd(prices.get(rewardSourceId(coin)));
    const quotePx = priceUsd(prices.get(coin.quote_type));
    out.push({
      sourceId: rewardSourceId(coin),
      name: meta.name,
      symbol: meta.symbol,
      iconUrl: meta.iconUrl,
      quoteSymbol: meta.quoteSymbol,
      rounds: coin.rounds,
      payouts: coin.payouts,
      received,
      usd:
        (received.coin > 0 && coinPx === null) ||
        (received.quote > 0 && quotePx === null)
          ? null
          : received.coin * (coinPx ?? 0) + received.quote * (quotePx ?? 0),
      lastMs: coin.last_payout_ms ?? 0,
      waiting: {
        next: amountsOf(meta, coin.waiting?.next ?? null),
        unpayable: amountsOf(meta, coin.waiting?.unpayable ?? null),
      },
    });
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}

/** The payouts of a page that can be drawn (their coin's metadata is known), in the page's order. */
export function rewardPayouts(
  payouts: readonly SocialRewardPayout[],
  meta: RewardCoinMeta,
): readonly RewardPayoutView[] {
  return payouts.flatMap((payout) => {
    const coin = meta.get(rewardSourceId(payout));
    if (!coin) return [];
    return [
      {
        key: `${payout.round_id}:${payout.digest}`,
        sourceId: rewardSourceId(payout),
        name: coin.name,
        symbol: coin.symbol,
        iconUrl: coin.iconUrl,
        quoteSymbol: coin.quoteSymbol,
        round: Number(payout.round_number) + 1,
        amounts: {
          coin: units(payout.meme_amount, coin.saleDecimals),
          exactCoin: atomsGrouped(BigInt(payout.meme_amount), coin.saleDecimals),
          exactQuote: atomsGrouped(BigInt(payout.quote_amount), coin.quoteDecimals),
          quote: units(payout.quote_amount, coin.quoteDecimals),
        },
        atMs: payout.timestamp_ms,
        digest: payout.digest,
        selfClaimed: payout.self_claimed,
      },
    ];
  });
}

/** Everything a summary page gives the tab, the page and the side card. */
export function rewardsView(
  page: SocialRewardsPage,
  prices: ReadonlyMap<string, SocialPriceHistory | null | undefined>,
) {
  return {
    coins: rewardCoins(page.coins, prices),
    latest: rewardPayouts(page.payouts, rewardCoinMeta(page.coins)),
  };
}
export type RewardsView = ReturnType<typeof rewardsView>;

/* ---------------- strings ---------------- */

/** `hidden(s)`: the eye masks an amount. */
export const masked = (text: string, hidden: boolean) =>
  hidden ? HIDDEN_AMOUNT : text;

/** Two places at most (the gate's `fmt2`): `0.35`, `1,204.5`. */
function fmt2(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
}

/** A quote amount (the gate's `rwQuote`): `$2.10 USDC`, `0.42 SUI`. */
export function quoteText(value: number, symbol: string): string {
  if (value > 0 && value < 0.01) return `${symbol === "USDC" ? "<$0.01" : "<0.01"} ${symbol}`;
  return symbol === "USDC"
    ? `${usd(value, 2)} USDC`
    : `${fmt2(value)} ${symbol}`;
}

/** The coin part: `+1,254 KSTL`. */
export const coinPart = (value: number, symbol: string) =>
  `${value > 0 && value < 0.01 ? "<0.01" : qty(value)} ${symbol}`;

/** Both parts (the gate's `rwAmts`): `+1,254 KSTL · +$2.10 USDC`. */
export function amountsText(
  amounts: RewardAmountsView,
  symbol: string,
  quoteSymbol: string,
): string {
  if (amounts.coin === 0) return `+${quoteText(amounts.quote, quoteSymbol)}`;
  if (amounts.quote === 0) return `+${coinPart(amounts.coin, symbol)}`;
  return `+${coinPart(amounts.coin, symbol)} · +${quoteText(amounts.quote, quoteSymbol)}`;
}

/** Exact token quantities remain available to assistive technology and pointer users. */
export function exactAmountsText(amounts: RewardAmountsView, symbol: string, quoteSymbol: string): string {
  const coin = `${amounts.exactCoin ?? amounts.coin} ${symbol}`;
  const quote = `${amounts.exactQuote ?? amounts.quote} ${quoteSymbol}`;
  return amounts.coin === 0 ? quote : amounts.quote === 0 ? coin : `${coin} · ${quote}`;
}

/** What came in, across coins (the gate's `rwGrandTxt`): `≈ $76.73`, `≈ $72.46 + LUMN`, or every coin's amounts when no dollar figure is known. */
export function grandText(coins: readonly RewardCoinView[]): string {
  const known = coins.filter((coin) => coin.usd !== null);
  const unknown = coins.filter((coin) => coin.usd === null);
  if (known.length === 0)
    return unknown
      .map((coin) => amountsText(coin.received, coin.symbol, coin.quoteSymbol))
      .join(" · ");
  const total = known.reduce((sum, coin) => sum + (coin.usd ?? 0), 0);
  return [`≈ ${total > 0 && total < 0.01 ? "<$0.01" : usd(total, 2)}`, ...unknown.map(coin => amountsText(coin.received, coin.symbol, coin.quoteSymbol))].join(" · ");
}

/** Whether any dollar figure is known ("At today’s prices" or "Prices not known yet"). */
export const anyUsd = (coins: readonly RewardCoinView[]) =>
  coins.some((coin) => coin.usd !== null);

/** How long ago (the gate's `rwWhen`): `just now`, `6 min ago`, `18 h ago`, `2 d ago`. */
export function whenText(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, (nowMs - atMs) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3_600)} h ago`;
  return `${Math.round(seconds / 86_400)} d ago`;
}

/** Whether a share waits that the relay sends with the next payout (the gate's `why: 'next'`). */
export const relayOwed = (coins: readonly RewardCoinView[]) =>
  coins.some((coin) => coin.waiting.next !== null);

/**
 * The waiting line's reason: the gate's two (`rwWaitTxt`), and for a share
 * the relay set aside (no gate line; OA-45's relay can mark one unpayable)
 * that its holder has to claim it.
 */
export function waitReason(kind: WaitKind): string {
  if (kind === "next") return "Queued for automatic delivery";
  return "Couldn’t be sent automatically. Claim it yourself.";
}

/** The holdings switch's sum on the Rewards tab (the gate's `rwTabSum`). Empty until the read answers or without payouts. */
export function rewardsTabSum(
  coins: readonly RewardCoinView[] | null,
  hidden: boolean,
): string {
  if (!coins || coins.length === 0) return "";
  return `${masked(grandText(coins), hidden)} received`;
}

/** A payout row's line (OA-46): the time, and who delivered it only when the wallet claimed it itself. */
export function payoutSub(payout: RewardPayoutView, nowMs: number): string {
  return `${whenText(payout.atMs, nowMs)}${payout.selfClaimed ? " · Claimed by your wallet" : ""}`;
}

/** A payout's accessible name (the gate's `rwAria`). */
export function payoutLabel(
  payout: RewardPayoutView,
  nowMs: number,
  hidden: boolean,
  explorer: string,
): string {
  return `${payout.name}, round ${payout.round}: ${masked(exactAmountsText(payout.amounts, payout.symbol, payout.quoteSymbol), hidden)}, ${whenText(payout.atMs, nowMs)}. ${payout.selfClaimed ? "Claimed by your wallet" : "Sent by Blast"}. Opens the transaction on ${explorer}`;
}

/** A collapsed coin's line (the gate's `rwCoinHTML`): `Last 6 h ago · 12 rounds`, `· 7 payouts` when not every round paid. */
export function coinSub(coin: RewardCoinView, nowMs: number): string {
  if (coin.payouts === 0) return "Awaiting first payout";
  const payouts = `${coin.payouts} ${coin.payouts === 1 ? "payout" : "payouts"}`;
  if (coin.rounds === null)
    return `Last ${whenText(coin.lastMs, nowMs)} · ${payouts}`;
  const rounds = `${coin.rounds} ${coin.rounds === 1 ? "round" : "rounds"}`;
  return `Last ${whenText(coin.lastMs, nowMs)} · ${payouts}${coin.payouts !== coin.rounds ? ` · ${rounds}` : ""}`;
}

/** A collapsed coin's value: dollars when known, else its coin amount; and the coin amount under it. */
export function coinValue(
  coin: RewardCoinView,
  hidden: boolean,
): Readonly<{ top: string; bottom: string }> {
  const amount = masked(amountsText(coin.received, coin.symbol, coin.quoteSymbol), hidden);
  return {
    top: amount,
    bottom: coin.usd !== null ? masked(`≈ ${coin.usd > 0 && coin.usd < 0.01 ? "<$0.01" : usd(coin.usd, 2)}`, hidden) : "",
  };
}

/** "Received +16,206 KSTL · +$38.43 USDC" inside an open coin. */
export function coinTotalText(coin: RewardCoinView, hidden: boolean): string {
  return `Received ${masked(amountsText(coin.received, coin.symbol, coin.quoteSymbol), hidden)}`;
}

/** "Show 10 more" while rows are left. */
export function moreText(left: number): string {
  return `Load more payouts (${Math.min(left, RW_MORE)})`;
}

/** The toast when a payout arrives (the gate's `rwReceive`). */
export function payoutToast(
  payout: RewardPayoutView,
): Readonly<{ title: string; sub: string }> {
  return {
    title: `You received rewards from ${payout.symbol}`,
    sub: `${amountsText(payout.amounts, payout.symbol, payout.quoteSymbol)} · Round ${payout.round}`,
  };
}
