import { useMemo } from "react";
import clsx from "clsx";

import type { HappeningCoin } from "@blast/core/web/contracts/happening.ts";
import { usePrice } from "../prices/price-client";
import styles from "./Happening.module.css";
import { Sparkline } from "#web/components/charts/Sparkline.tsx";
import { trendingSparkPoints } from "./trending-spark";

/** The move's colour: green up, red down, the slot's own colour without a move. */
function toneOf(change: number | null): string | undefined {
  return change !== null && change > 0 ? styles.up : change !== null && change < 0 ? styles.down : undefined;
}

export function TrendingCoinSparkline({ coin, refresh }: Readonly<{ coin: HappeningCoin; refresh?: number }>) {
  const history = usePrice({ presaleId: coin.presale_id, coin: coin.coin_type, window: "24h" }, refresh);
  const points = useMemo(() => trendingSparkPoints(history?.points), [history?.points]);
  return (
    <span aria-hidden="true" className={clsx(styles.trendingSpark, toneOf(coin.change_24h_bps))} data-slot="trending-sparkline">
      <Sparkline points={points} height={24} width={72} ink />
    </span>
  );
}
