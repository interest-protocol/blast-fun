"use client";

import { useEffect, useState, type ReactNode } from "react";

import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";

import { priceCoversHeader, subscribeChartPrice, type ChartPriceUpdate } from "../chart/chart-live-price";
import { formatPricePerToken } from "./coin-format";
import styles from "./Coin.module.css";

/** Reuses the chart's accepted prices; this subscriber never opens another connection. */
export function StreamedPrice({ poolKey, expected, checkpoint, memeDecimals, quoteDecimals, quoteSymbol, children }: Readonly<{
  poolKey: string;
  expected: ExpectedDeployment | null;
  checkpoint: number | null;
  memeDecimals: number;
  quoteDecimals: number;
  quoteSymbol: string;
  children: ReactNode;
}>) {
  const [received, setReceived] = useState<Readonly<{ update: ChartPriceUpdate; paused: boolean }> | null>(null);
  const network = expected?.network;
  const deployment = expected?.deployment;

  useEffect(() => subscribeChartPrice(
    poolKey,
    network && deployment ? { network, deployment } : null,
    (update) => setReceived((previous) => update
      ? { update, paused: false }
      : previous && { ...previous, paused: true }),
  ), [poolKey, network, deployment]);

  // A newer HTTP page remains authoritative while its stream catches up.
  if (!received || !priceCoversHeader(received.update, checkpoint)) return children;
  const { update, paused } = received;
  return (
    <>
      <span>
        {formatPricePerToken(update.price, memeDecimals, quoteDecimals, 4)} {quoteSymbol}
      </span>
      {paused ? <span className={styles.missing}> · Price updates delayed</span> : null}
    </>
  );
}
