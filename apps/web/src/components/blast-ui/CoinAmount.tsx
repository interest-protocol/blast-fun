"use client";

import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";

import { CoinMark } from "./CoinMark";
import { Ticker } from "./Ticker";
import { coinLogoUrl, useCoinImages } from "./coin-images";

type CoinAmountProps = Readonly<{
  amount: string;
  symbol: string;
  coinType?: string | null;
  iconUrl?: string | null;
}>;

/** The amount stays attached to its unit. A ticker covers coins without usable artwork. */
export function CoinAmount({ amount, symbol, coinType, iconUrl }: CoinAmountProps) {
  const { failed } = useCoinImages();
  const canonical = coinType ? coreCoin(coinType) : undefined;
  const url = coinLogoUrl(iconUrl, canonical?.logoUrl, failed);
  const showMark = canonical?.symbol === "SUI" || canonical?.symbol === "USDC" || url != null;
  if (!showMark) return <span>{amount}{"\u00a0"}<Ticker symbol={symbol} bare /></span>;

  return (
    <span className="coin-amount" title={symbol}>
      {amount}
      <CoinMark coin={{ key: coinType ?? `coin-${symbol}`, coinType: coinType ?? undefined, iconUrl: url ?? null }} size={16} />
      <span className="sr-only"> {symbol}</span>
    </span>
  );
}

export function TradeFill({ verb, first, second }: Readonly<{
  verb: "Bought" | "Sold" | "Traded";
  first: CoinAmountProps;
  second: CoinAmountProps;
}>) {
  return <>{verb} <CoinAmount {...first} /> for <CoinAmount {...second} /></>;
}
