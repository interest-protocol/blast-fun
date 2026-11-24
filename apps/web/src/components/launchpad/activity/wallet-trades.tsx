"use client";

import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const EMPTY: readonly ActivityRow[] = [];
const LaunchWallet = createContext<string | null>(null);
const WalletTrades = createContext(EMPTY);
const LatestActivityTrade = createContext<ActivityRow | null>(null);
type PublishedTrades = Readonly<{ rows: readonly ActivityRow[]; latestTrade: ActivityRow | null }>;
const EMPTY_TRADES: PublishedTrades = { rows: EMPTY, latestTrade: null };
const Publish = createContext<((trades: PublishedTrades) => void) | null>(null);

export function WalletTradesProvider({ deployer, children }: Readonly<{ deployer: string | null; children: ReactNode }>) {
  const [trades, setTrades] = useState(EMPTY_TRADES);
  return <LaunchWallet.Provider value={deployer}>
    <Publish.Provider value={setTrades}>
      <LatestActivityTrade.Provider value={trades.latestTrade}>
        <WalletTrades.Provider value={trades.rows}>{children}</WalletTrades.Provider>
      </LatestActivityTrade.Provider>
    </Publish.Provider>
  </LaunchWallet.Provider>;
}

export function usePublishWalletTrades(rows: readonly ActivityRow[], latestTrade: ActivityRow | null = null) {
  const publish = useContext(Publish);
  useEffect(() => {
    publish?.({ rows, latestTrade });
  }, [publish, rows, latestTrade]);
  useEffect(() => () => publish?.(EMPTY_TRADES), [publish]);
}

export const useLaunchWallet = () => useContext(LaunchWallet);
export const useWalletTrades = () => useContext(WalletTrades);
export const useLatestActivityTrade = () => useContext(LatestActivityTrade);
