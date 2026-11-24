"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { use, useCallback, useState, type ReactNode } from "react";

import { StandaloneCurveTrade } from "#web/components/launchpad/trade/CoinTrade.tsx";
import { CurveTradeUnavailable } from "#web/components/launchpad/trade/CurveTradeRail.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { CurveTradeSetupContext } from "../curve-trade-context";
import type { CoinAsset, CoinRecord } from "./coin-reads";
import { curveLaunchQuery, mayTradeOnCurve } from "./curve-launch";

function activeCurveLaunch(candidate: boolean, read: UseQueryResult<string | null>, retained: string | null): string | null {
  if (!candidate) return null;
  // A confirmed migration clears the rail even when it previously held a launch.
  if (read.data !== undefined && !read.isPlaceholderData) return read.data;
  return read.isError ? retained : (read.data ?? null);
}

/**
 * The panel's trade section for a coin still on its bonding curve: the coin
 * page's curve rail (or, when trading is off here, its reason) in place of the
 * aggregator box, which cannot fill a curve. Graduated, presale and non-Blast
 * coins keep `children` (the aggregator box). The launch comes from one read
 * of the coin's market summary (no polling), re-read after a trade and when
 * the rail sees the launch migrate; the next answer that names another pool,
 * or the coin read marking it migrated, hands the panel back to the box.
 */
export function CurveLaunchTrade({
  asset,
  coin,
  visible,
  children,
}: Readonly<{
  asset: CoinAsset;
  coin: CoinRecord | null;
  visible: boolean;
  children: ReactNode;
}>) {
  const setup = use(CurveTradeSetupContext);
  const client = useAppQueryClient();
  const candidate = setup !== null && mayTradeOnCurve(asset, coin);
  const read = useQuery({ ...curveLaunchQuery(client, asset), enabled: candidate && visible }, client);
  const [retained, setRetained] = useState<string | null>(null);
  const launchId = activeCurveLaunch(candidate, read, retained);
  if (launchId !== null && launchId !== retained) setRetained(launchId);
  const { network, coin_type: coinType } = asset;
  // The rail refreshes its own curve read and the wallet reads after a trade; the panel's coin, chart and
  // trades keep their own 15 s reads, so a trade only re-asks which pool the coin trades on.
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: queryKeys.workspace.curveLaunch(network, coinType) }).catch(() => {});
  }, [client, network, coinType]);
  const shown = launchId ?? retained;
  if (setup === null || shown === null) return children;
  if (setup.availability.status === "unavailable") {
    return launchId === null ? children : <CurveTradeUnavailable reason={setup.availability.reason} />;
  }
  return (
    <StandaloneCurveTrade
      key={shown}
      config={setup.availability.config}
      connection={setup.connection}
      launchId={shown}
      coinType={coinType}
      live={launchId !== null}
      onInvalidate={refresh}
      onMigrated={refresh}
      fallback={children}
    />
  );
}
