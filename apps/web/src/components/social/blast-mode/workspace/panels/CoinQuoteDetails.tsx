import type {
  SocialTradeQuote,
  TradeFeeRequired,
} from "@blast/core/web/contracts/trades.ts";
import { impactText } from "#web/components/social/trades/trade-quote-view.ts";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import type { TradeFacts } from "./trade-model";
import styles from "./CoinTrade.module.css";
import type { ReactNode } from "react";

export function CoinQuoteDetails({
  hasAmount = true,
  quote,
  fee,
  facts,
  side,
  exact,
}: Readonly<{
  hasAmount?: boolean;
  quote: SocialTradeQuote | null;
  fee: TradeFeeRequired | null | undefined;
  facts: TradeFacts;
  side: "buy" | "sell";
  exact: (
    atoms: string | null,
    decimals: number,
    symbol: string,
    label: string,
  ) => ReactNode;
}>) {
  const networkFee = fee
    ? { label: "Paid from your SUI", estimate_mist: fee.feeMist }
    : quote?.network_fee;
  const { buy, inDecimals, outDecimals, inSymbol, outSymbol } = quoteAmounts(facts, side);
  const amount = (
    atoms: string | null | undefined,
    decimals: number | null,
    symbol: string,
    label: string,
  ) =>
    decimals === null
      ? "Unavailable"
      : exact(atoms ?? null, decimals, symbol, label);
  return (
    <dl className={styles.tradeFacts} aria-label="Trade facts">
      <div className={styles.wideFact}>
        <dt>Available balance</dt>
        <dd>
          {amount(
            (buy ? (facts.counter ? facts.counter.balance : facts.usdc) : facts.held)?.toString(),
            inDecimals,
            inSymbol,
            "available balance",
          )}
        </dd>
      </div>
      {!hasAmount ? <div className={styles.wideFact}><dt className="sr">Quote</dt><dd>Enter an amount to see a quote</dd></div> : <>
      <div className={styles.wideFact}>
        <dt>Spending</dt>
        <dd>{amount(quote?.amount_in, inDecimals, inSymbol, "trade spend")}</dd>
      </div>
      <div className={styles.wideFact}>
        <dt>Estimated receive</dt>
        <dd>
          {amount(
            quote?.amount_out,
            outDecimals,
            outSymbol,
            "estimated receive",
          )}
        </dd>
      </div>
      <div className={styles.wideFact}>
        <dt>Minimum receive</dt>
        <dd>
          {amount(quote?.min_out, outDecimals, outSymbol, "minimum receive")}
        </dd>
      </div>
      <div>
        <dt>Price impact</dt>
        <dd>
          {quote?.price_impact_bps == null
            ? "Unavailable"
            : impactText(quote.price_impact_bps)}
        </dd>
      </div>
      <div>
        <dt>Venue fee</dt>
        <dd>{amount(quote?.fee_amount, inDecimals, inSymbol, "venue fee")}</dd>
      </div>
      <div>
        <dt>Blast fee</dt>
        <dd>
          {amount(quote?.blast_fee_amount, outDecimals, outSymbol, "Blast fee")}
        </dd>
      </div>
      <div className={styles.wideFact}>
        <dt>Route</dt>
        <dd>
          <RouteText quote={quote} />
        </dd>
      </div>
      <div className={styles.wideFact}>
        <dt>Network fee</dt>
        <dd>
          {networkFee?.label ?? "Unavailable"}
          {networkFee && (
            <> · {amount(networkFee.estimate_mist, 9, "SUI", "network fee")}</>
          )}
        </dd>
      </div>
      </>}
    </dl>
  );
}

function quoteAmounts(facts: TradeFacts, side: "buy" | "sell") {
  const buy = side === "buy";
  const inDecimals = buy ? (facts.counter?.decimals ?? facts.usdcDecimals) : facts.decimals;
  const outDecimals = buy ? facts.decimals : (facts.counter?.decimals ?? facts.usdcDecimals);
  const inSymbol = buy ? (facts.counter?.symbol ?? "USDC") : facts.symbol;
  const outSymbol = buy ? facts.symbol : (facts.counter?.symbol ?? "USDC");
  return { buy, inDecimals, outDecimals, inSymbol, outSymbol };
}

/** The route's pair in the quote's own words, then each venue it crosses by its logo and name. */
function RouteText({ quote }: Readonly<{ quote: SocialTradeQuote | null }>) {
  const venues = [
    ...new Set(
      (quote?.route ?? []).map((hop) => hop.venue.toLowerCase()).filter(Boolean),
    ),
  ];
  if (venues.length === 0) return quote?.route_label ?? "Unavailable";
  const label = quote?.route_label ?? "";
  const pair = label.includes(" · ") ? label.split(" · ")[0] : null;
  return (
    <span className={styles.route}>
      {pair ? <span>{pair}</span> : null}
      {venues.map((venue) => (
        <DexIdentity iconOnly key={venue} venue={venue} />
      ))}
    </span>
  );
}
