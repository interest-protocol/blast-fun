"use client";

import { NO_VALUE } from "@blast/core/web/format.ts";
import { deploymentMismatch, type ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";

import { useChartPrice } from "../chart/chart-live-price";
import { formatPricePerToken } from "./coin-format";

/** Reuses the chart's accepted prices on the tab's existing connection. */
export function StreamedPrice({ poolKey, expected, checkpoint, memeDecimals, quoteDecimals, quoteSymbol }: Readonly<{
  poolKey: string;
  expected: ExpectedDeployment | null;
  checkpoint: number | null;
  memeDecimals: number;
  quoteDecimals: number;
  quoteSymbol: string;
}>) {
  const update = useChartPrice(poolKey, checkpoint);
  if (!update || deploymentMismatch(update.provenance, expected)) return NO_VALUE;
  return <span>{formatPricePerToken(update.price, memeDecimals, quoteDecimals, 4)} {quoteSymbol}</span>;
}
