import {
  readCoinCandles,
  type CoinCandlePage,
} from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { POOL_KEY, type Venue } from "@blast/core/modules/launchpad-contract/venues.ts";
import { exactDecimal, exactText, multiplyExact, shiftExact, type Exact } from "@blast/core/lib/exact-amount.ts";
import { z } from "zod";
import { readCoinMarketSummary } from "@blast/core/modules/launchpad-contract/coin.ts";
import type { Provenance } from "@blast/core/web/launchpad-read.ts";
import type { PriceWindow } from "@blast/core/web/contracts/prices.ts";
import {
  priceTierFor,
  PRICE_WINDOW_MS,
} from "@blast/core/web/contracts/prices.ts";
import { browserMarketDependencies } from "#web/components/launchpad/blast-infra-browser.ts";
import {
  chartRequest,
  type ChartRequest,
} from "#web/components/launchpad/chart/chart-model.ts";
import { applyChartFrame, type ChartFrame } from "#web/components/launchpad/chart/chart-live-model.ts";
import type { CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import type { CoinAsset } from "./coin-reads";

export type MarketCoinHistory = Readonly<{
  kind: "market";
  coin_type: string;
  page: CoinCandlePage;
  request: ChartRequest;
  stale: boolean;
  provenance: Provenance;
  decimals: number | null;
  quoteDecimals: number | null;
  /** The pool the coin trades in now (the summary's `current_pool`); null without a summary. */
  poolKey: string | null;
}>;

export async function coinMarketHistory(
  asset: CoinAsset,
  window: PriceWindow,
  signal: AbortSignal,
  interval?: CandleInterval,
): Promise<MarketCoinHistory | null> {
  signal.throwIfAborted();
  const request = chartRequest(
    {
      interval:
        interval ??
        priceTierFor(
          window === "launch"
            ? PRICE_WINDOW_MS["24h"]
            : PRICE_WINDOW_MS[window],
        ),
      range: window === "launch" ? "all" : window,
    },
    Date.now(),
  );
  const dependencies = browserMarketDependencies(null, (input, init) =>
    gatedFetch(input, {
      ...init,
      signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
    }),
  );
  const answer = await readCoinCandles(asset.coin_type, request, dependencies);
  if (signal.aborted) throw signal.reason;
  if (
    answer.status === "unavailable" ||
    answer.provenance.network !== asset.network ||
    answer.data.kind !== "answer"
  )
    return null;
  // The summary supplies the decimal metadata needed to show prices.
  const summary = await readCoinMarketSummary(asset.coin_type, dependencies);
  if (signal.aborted) throw signal.reason;
  const metadata =
    summary.status !== "unavailable" &&
    summary.provenance.network === asset.network &&
    summary.data.kind === "answer"
      ? summary.data.value
      : null;
  return {
    kind: "market",
    coin_type: asset.coin_type,
    page: answer.data.value,
    request,
    stale: answer.status === "stale",
    provenance: answer.provenance,
    decimals: metadata?.decimals ?? null,
    quoteDecimals: metadata?.quoteDecimals ?? null,
    poolKey: metadata?.currentPool ?? null,
  };
}

/**
 * One stream frame on the coin's candles, through the coin page's `applyChartFrame`: the coin's
 * page is its current pool's from the migration on. Throws `ChartBackfillRequired` when only a new
 * history read can continue the candles.
 */
export function applyMarketFrame(history: MarketCoinHistory & Readonly<{ poolKey: string }>, frame: ChartFrame): MarketCoinHistory {
  const venue = POOL_KEY.exec(history.poolKey)![1] as Venue;
  const page = applyChartFrame(
    { poolKey: history.poolKey, source: venue === "blast_curve" ? "curve" : "venue", venue, interval: history.page.interval, candles: history.page.candles, migration: history.page.migration },
    frame,
    history.request,
  );
  return page.candles === history.page.candles ? history : { ...history, page: { ...history.page, candles: page.candles } };
}

/** A decimal count on the wire: a digit string, as blast-infra's pool summary writes `inputs`. */
const decimals = z.string().regex(/^(0|[1-9][0-9]{0,2})$/).transform(Number).pipe(z.number().max(255));

/** The fields of a trade frame's pool summary (blast-infra's `pool_summary`) that price the coin in USD. */
const tradeSummarySchema = z.object({
  quote: z.string(),
  price: z.string().nullable(),
  inputs: z.object({ meme_decimals: decimals, quote_decimals: decimals.nullable() }),
  quote_usd: z.object({ price: z.string().regex(/^(0|[1-9][0-9]*)$/), expo: z.number().int().min(-255).max(20) }).nullable(),
});

/**
 * What a trade frame's pool summary says about pricing it in USD: the pool's price after the trade
 * (the mark the catalog prices from), both coins' decimals and the quote's USD stamp. Null when it
 * is malformed or the quote's decimals are unknown.
 */
export type TradeQuote = Readonly<{ quote: string; price: string | null; memeDecimals: number; quoteDecimals: number; quoteUsd: string | null }>;

export function tradeQuote(summary: unknown): TradeQuote | null {
  const parsed = tradeSummarySchema.safeParse(summary);
  if (!parsed.success) return null;
  const { quote, price, inputs, quote_usd: usd } = parsed.data;
  if (inputs.quote_decimals === null) return null;
  return {
    quote,
    price,
    memeDecimals: inputs.meme_decimals,
    quoteDecimals: inputs.quote_decimals,
    quoteUsd: usd ? exactText(shifted({ n: BigInt(usd.price), scale: 0 }, -usd.expo)) : null,
  };
}

/**
 * The USD price of one whole coin: `price × 10^(meme_decimals − quote_decimals) × quote USD`,
 * where `price` is quote atoms per meme atom. Exact, as the catalog's `usd_price` is.
 */
export function estimateUsdPrice(price: string, memeDecimals: number, quoteDecimals: number, quoteUsd: string): string | null {
  const atoms = exactDecimal(price);
  const usd = exactDecimal(quoteUsd);
  if (!atoms || !usd) return null;
  return exactText(multiplyExact(shifted(atoms, quoteDecimals - memeDecimals), usd));
}

/** `value ÷ 10^k` with a scale of at least zero, which every exact formatter expects. */
function shifted(value: Exact, k: number): Exact {
  const next = shiftExact(value, k);
  return next.scale >= 0 ? next : { n: next.n * 10n ** BigInt(-next.scale), scale: 0 };
}
