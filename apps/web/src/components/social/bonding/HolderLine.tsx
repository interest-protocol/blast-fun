"use client";

import { useContext } from "react";
import { normalizeStructTag } from "@mysten/sui/utils";
import { useQuery } from "@tanstack/react-query";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { ChartMarketCapSupply } from "#web/components/launchpad/chart/chart-market-cap.ts";
import { useHeldCoin } from "#web/components/launchpad/trade/held-balance.tsx";
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
 * trader whose wallet a trade rail on screen has seen holding this coin: once per page open, and once
 * again after each of their own committed trades. No polling and no read on focus. Without a portfolio,
 * or until a rail has read this account holding the coin (and after a sell of all of it), it shows nothing. While the read is in flight
 * the line keeps its space unseen, so nothing moves when it lands.
 */
export function HolderLine({ coinType, capUsd }: Readonly<{ coinType: string | null; capUsd: string | null }>) {
  const supply = useContext(ChartMarketCapSupply);
  const { amountsHidden } = useShellPrefs();
  const { signedIn, getAccessToken } = useSocialViewer();
  const held = useHeldCoin(coinType);
  const { data, isFetching } = useQuery({
    ...portfolioQuery(getAccessToken ?? noToken, undefined, false),
    enabled: signedIn && getAccessToken !== undefined && held === "holds",
    staleTime: HOLDER_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  }, useAppQueryClient());
  if (!coinType || !supply || amountsHidden || !signedIn || held !== "holds") return null;
  const line = data?.wallet_sync?.status === "ready" ? holderLine(positionOf(data.coins, coinType), supply.atoms, capUsd) : null;
  if (!line) return isFetching ? <span className={styles.holderLine} data-holder-line="" aria-hidden /> : null;
  return <span className={styles.holderLine} data-holder-line="">
    <span>In at {line.entry}</span>
    <span className={styles.priceChange} data-direction={line.tone === "flat" ? undefined : line.tone}>{line.pnl} · {line.percent}</span>
  </span>;
}

function positionOf<Coin extends Readonly<{ coin_type: string }>>(coins: readonly Coin[] | null | undefined, coinType: string): Coin | undefined {
  const type = normalizeStructTag(coinType);
  return coins?.find((coin) => normalizeStructTag(coin.coin_type) === type);
}
