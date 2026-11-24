import { createContext, type ReactNode } from "react";
import type { HomeThreadPage } from "@blast/core/web/contracts/home.ts";
import type { CoinRecord } from "./coin-reads";
import type { useCoinRead } from "./use-coin-read";
import type { ChartAnnotation } from "./chart-trades";

export type ChartActivityRead = ReturnType<typeof useCoinRead<HomeThreadPage | null>>;
export type ChartTradesValue = Readonly<{
  trades: readonly ChartAnnotation[];
  coin: CoinRecord | null;
  enabled: boolean;
  notice: ReactNode;
  partial: boolean;
  ready: boolean;
  window: string | null;
}>;
export const ChartTradesContext = createContext<ChartTradesValue>({ trades: [], coin: null, enabled: false, notice: null, partial: false, ready: false, window: null });
