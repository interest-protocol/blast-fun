import { TradeFill } from "#web/components/blast-ui/CoinAmount.tsx";

import { completedTradeAmounts, type CompletedTrade } from "./completed-trade";
import type { Curve } from "./curve-read";

export function CurveTradeFill({ trade, curve, iconUrl }: Readonly<{ trade: CompletedTrade; curve: Curve; iconUrl?: string | null }>) {
  const amounts = completedTradeAmounts(trade, curve.decimals, curve.quote.decimals);
  return <TradeFill verb={trade.kind}
    first={{ amount: amounts.meme, symbol: curve.symbol, coinType: curve.launch.memeType, iconUrl }}
    second={{ ...curve.quote, amount: amounts.quote }}
  />;
}
