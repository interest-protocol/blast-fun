"use client";

import { useContext } from "react";
import { normalizeStructTag } from "@mysten/sui/utils";
import { useQuery } from "@tanstack/react-query";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { ChartMarketCapSupply } from "#web/components/launchpad/chart/chart-market-cap.ts";
import { useHoldsPageCoin } from "#web/components/launchpad/trade/held-balance.tsx";
import { portfolioQuery } from "#web/components/social/queries.ts";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { holderLine } from "./holder-line.ts";
import styles from "./bonding-coin.module.css";

const noToken = async () => null;
/** The cost basis moves only with the trader's own trades, which invalidate it; no timer reads it again. */
const HOLDER_STALE_MS = 30 * 60_000;

/**
 * "In at $12K · +$340 · +600%" for a holder of `coinType`, from the account's cost basis: the shared
 * full portfolio (Blast mode's coin panels read the same entry). It reads only for a signed-in
 * trader whose wallet the trade rail has seen holding this coin: once per page open, and once again
 * after each of their own committed trades. No polling and no read on focus. Without a portfolio, or
 * for a non-holder, it shows nothing.
 */
export function HolderLine({ coinType, capUsd }: Readonly<{ coinType: string | null; capUsd: string | null }>) {
  const supply = useContext(ChartMarketCapSupply);
  const { amountsHidden } = useShellPrefs();
  const { signedIn, getAccessToken } = useSocialViewer();
  const holds = useHoldsPageCoin();
  const { data } = useQuery({
    ...portfolioQuery(getAccessToken ?? noToken, undefined, false),
    enabled: signedIn && getAccessToken !== undefined && holds && !!coinType,
    staleTime: HOLDER_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  }, useAppQueryClient());
  if (!coinType || !supply || amountsHidden || data?.wallet_sync?.status !== "ready") return null;
  const type = normalizeStructTag(coinType);
  const held = data.coins?.find((coin) => normalizeStructTag(coin.coin_type) === type);
  const line = holderLine(held, supply.atoms, capUsd);
  return line && <span className={styles.holderLine} data-holder-line="">
    <span>In at {line.entry}</span>
    <span className={styles.priceChange} data-direction={line.tone === "flat" ? undefined : line.tone}>{line.pnl} · {line.percent}</span>
  </span>;
}
