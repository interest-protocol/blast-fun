import { readablePrice } from "#web/lib/market-format.ts";

import { quoteAmount } from "./quote-asset";

import { wholePrice } from "./venue-adapter";
import { recordedPoolPrice, type RecordedVenue, type VenueTrade } from "./venue-route";
import { VENUE_PRODUCTS } from "@blast/core/modules/launchpad-contract/venues.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

/** The pool's price before any trade, in the quote coin per whole meme coin. */
export function poolPriceText(recorded: RecordedVenue): string {
  const price = wholePrice(recordedPoolPrice(recorded), recorded.decimals, recorded.quote.decimals);
  return `1 ${recorded.symbol} = ${readablePrice(price)} ${recorded.quote.symbol}`;
}

/** What a reconciled swap did, in words. */
export function describeVenueTrade(trade: VenueTrade, recorded: Pick<RecordedVenue, "symbol" | "decimals" | "venue" | "quote">): string {
  const coin = `${atomsGrouped(trade.memeAmount, recorded.decimals)} ${recorded.symbol}`;
  const quote = quoteAmount(trade.quoteAmount, recorded.quote);
  return trade.side === "buy"
    ? `Bought ${coin} for ${quote} on ${VENUE_PRODUCTS[recorded.venue]}.`
    : `Sold ${coin} for ${quote} on ${VENUE_PRODUCTS[recorded.venue]}.`;
}
