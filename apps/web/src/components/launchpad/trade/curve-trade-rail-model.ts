
import { previewBuy, previewSell } from "@interest-protocol/blast-sdk/launchpad";

import { parseTradeAmount } from "./amount";

import { inputDecimals, type CurveTradeInput, type TradeDirection } from "./curve-adapter";
import { minimumOut } from "@blast/core/lib/bps.ts";
import type { Curve } from "./curve-read";

import { curveFeeValue, quoteAmount } from "./quote-asset";
import { atomsGrouped } from "@blast/core/web/format.ts";

export type IndicativeEstimate = Readonly<{ receive: string; minimum: string; detail?: string; refund?: string; burn?: string; minimumAtomic?: bigint }>;

/** The estimate from the last curve read, with every curve fee the trade pays; null when there is none to show. */
export function indicativeEstimate(curve: Curve, input: CurveTradeInput, direction: TradeDirection): IndicativeEstimate | null {
  const amount = parseTradeAmount(input.amount, inputDecimals(direction, curve));
  if (!amount.ok || curve.launch.lifecycle !== "Live") return null;
  const formatQuote = (atoms: bigint) => quoteAmount(atoms, curve.quote);
  const coin = (atoms: bigint) => `${atomsGrouped(atoms, curve.decimals)} ${curve.symbol}`;
  try {
    if (direction === "buy") {
      const preview = previewBuy(curve.launch, amount.atomic);
      return {
        receive: coin(preview.memeOutNet),
        minimum: coin(minimumOut(preview.memeOutNet, input.slippageBps)),
        minimumAtomic: minimumOut(preview.memeOutNet, input.slippageBps),
        detail: curveFeeValue(preview.quoteFee, preview.memeFee, formatQuote, coin),
        refund: preview.quoteRefund > 0n ? formatQuote(preview.quoteRefund) : undefined,
      };
    }
    const preview = previewSell(curve.launch, amount.atomic, curve.launch.sellBurnBps);
    return {
      receive: formatQuote(preview.quoteOutNet),
      minimum: formatQuote(minimumOut(preview.quoteOutNet, input.slippageBps)),
      minimumAtomic: minimumOut(preview.quoteOutNet, input.slippageBps),
      detail: curveFeeValue(preview.quoteFee, preview.memeFee, formatQuote, coin),
      burn: preview.pendingBurnDelta > 0n ? coin(preview.pendingBurnDelta) : undefined,
    };
  } catch {
    return null;
  }
}
