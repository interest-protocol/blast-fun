"use client";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { coinTypeIdentity } from "../panel-identities";
import { useTradeReads } from "#web/components/launchpad/trade-reads.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useCurrentBlastAccount } from "../BlastActionProvider";
import { coinPanelPnlKey, useAccountCoinRead } from "./use-coin-read";
import { currentPnl, ownTrade, type CoinPnl } from "./coin-pnl";
import { terminalUsd } from "./coin-facts";
import type { CoinPanelProps } from "./CoinPanel";
import styles from "./FocusPanel.module.css";

export function CoinPnlMetric({ asset, actions, visible, symbol: providedSymbol }: Pick<CoinPanelProps, "asset" | "actions"> & Readonly<{ visible: boolean; symbol?: string }>) {
  const symbol = providedSymbol ?? coinTypeIdentity(asset.coin_type).symbol;
  const { pnl } = actions;
  const enabled = visible && actions.authenticated && asset.network === "mainnet";
  const read = useAccountCoinRead(enabled, coinPanelPnlKey(actions.actor_key, asset.network, asset.coin_type), () => pnl?.(asset) ?? Promise.resolve(null));
  const hidden = useShellPrefs().amountsHidden;
  useOwnTradeRefresh(enabled ? asset.coin_type : null);
  if (!enabled) return null;
  return <CurrentPnlMetric read={read} hidden={hidden} symbol={symbol} />;
}

/**
 * Re-reads the viewer's cost basis (the shared portfolio this PnL comes from) when the viewer's own
 * trade of this coin crosses the tab's market stream, from any device; nobody else's trade moves it.
 * The price between reads stays the portfolio's.
 */
function useOwnTradeRefresh(coinType: string | null) {
  const client = useAppQueryClient();
  const wallets = useCurrentBlastAccount().accountState?.account?.wallets;
  const key = wallets?.map((wallet) => wallet.address).join(",") ?? "";
  useTradeReads({
    coinType: key ? coinType : null,
    minGapMs: 0,
    fallbackMs: NO_POLL,
    initial: false,
    accept: ownTrade(key ? key.split(",") : []),
    read: () => void client.invalidateQueries({ queryKey: queryKeys.me.portfolio() }, { cancelRefetch: false }),
  });
}

const NO_POLL = { live: null, idle: null } as const;

function CurrentPnlMetric({ read, hidden, symbol }: Readonly<{ read: ReturnType<typeof useAccountCoinRead<CoinPnl | null>>; hidden: boolean; symbol: string }>) {
  const result = currentPnl(read.value);
  if (read.status !== "pending" && read.status !== "error" && !result && !hidden) return null;
  let content;
  if (hidden) content = "••••";
  else if (read.status === "pending") content = <span role="status" aria-label="Loading current PnL"><SkeletonText>+$000 · 00%</SkeletonText></span>;
  else if (read.status === "error") content = <Button variant="ghost" size="sm" className={styles.positionAction} aria-label="Retry current PnL" type="button" onClick={read.retry}>Retry</Button>;
  else if (result) content = <span className={styles.pnl} data-direction={result.tone}><InspectValue label="current unrealized PnL across linked wallets" value={`${result.amount}${result.percent ? ` (${result.percent})` : ""} · acquisition cost $${read.value!.basis_usd}`}>{terminalUsd(`${result.tone === "up" ? "+" : ""}${read.value!.pnl_usd}`)}{result.percent && <span className={styles.pnlPercent}> {result.percent}</span>}</InspectValue></span>;
  return <div className={styles.positionPnl}><dt title={`${symbol} across your linked wallets`}>Unrealized PnL</dt><dd>{content}</dd></div>;
}
