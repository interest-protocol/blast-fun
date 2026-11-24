"use client";

import { publicErrorMessage } from "#web/lib/errors.ts";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";

import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { walletQuery } from "../queries";
import { useSocialViewer } from "../SignInGate";
import { coinView, walletCoinViews, type WalletCoinView } from "./coin-model";
import type { HoldingsLoader } from "./CoinBrowser";

/**
 * The Blast wallet's coins for a surface outside the coins sheet: Home's
 * "Your coins" card and the collapsed right column (R3-09, R3-10).
 *
 * Owner-only and signed-in only. The call goes through `callSocialApi`
 * (`coins-client.ts` → `social-fetch.ts`): a Privy access token when the
 * viewer has one, the Sui wallet session cookie otherwise (OA-16). No header
 * is ever hand-built here.
 *
 * It runs only in the browser after hydration, so the server HTML is the same
 * for every reader and no personal balance is ever part of it. It is the
 * paged `GET /api/social/me/wallet` query: cards and the coins sheet share
 * matching pages; transaction forms retain their complete balance read.
 * It reads again when the balances move (a
 * deposit landed, a withdrawal went out: `invalidateAfter("balances")`) and
 * keeps the last answer on screen meanwhile, so the column does not flicker.
 */

export type WalletCoinsRead = Readonly<{
  /**
   * `none` for a visitor and before hydration, `error` when the call failed or
   * the fullnode could not be read (`coins: null`).
   */
  status: "none" | "loading" | "error" | "ready";
  coins: readonly WalletCoinView[];
  /** The wallet's total in USD (the paged listing's `value_usd`, every holding); null while one has no price. */
  value?: number | null;
  /** Safe read failure with the backend reference when available. */
  message?: string;
  /** Reads again (the card's "Try again"). */
  retry: () => void;
}>;

const NO_COINS: readonly WalletCoinView[] = Object.freeze([]);
const noToken = async () => null;

export function useSwapPickerHoldings(refreshOnOpen = false): HoldingsLoader | undefined {
  const client = useAppQueryClient();
  const { signedIn, getAccessToken } = useSocialViewer();
  const { hideSmallBalances } = useShellPrefs();
  const load = useCallback<HoldingsLoader>(async (page, q, mode, signal) => {
    const query = walletQuery(getAccessToken ?? noToken, { page, q, mode, hide_small: hideSmallBalances });
    const result = await client.fetchQuery(refreshOnOpen ? { ...query, staleTime: 0 } : query);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (result.coins === null || !result.listing) throw new Error("Holdings unavailable");
    return { coins: result.coins.map(coinView), total: result.listing.total, page: result.listing.page };
  }, [client, getAccessToken, hideSmallBalances, refreshOnOpen]);
  return signedIn ? load : undefined;
}

export function useWalletCoins(key = ""): WalletCoinsRead {
  const { hideSmallBalances } = useShellPrefs();
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const signedIn = hydrated && viewer.signedIn;
  const query = useQuery({ ...walletQuery(viewer.getAccessToken ?? noToken, { page: 1, hide_small: hideSmallBalances, key }), enabled: signedIn }, useAppQueryClient());
  const { refetch, data, isError } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const coins = useMemo(() => (data && data.coins !== null ? walletCoinViews(data) : null), [data]);
  if (!signedIn) return { status: "none", coins: NO_COINS, retry };
  // A failed read, or a wallet the fullnode could not read, is the error state; a re-read keeps the last answer showing.
  if (coins === null && (isError || data !== undefined)) return { status: "error", coins: NO_COINS, retry, message: publicErrorMessage(query.error, "Your wallet could not load. Nothing changed.", "service_unavailable") };
  if (coins === null) return { status: "loading", coins: NO_COINS, retry };
  const total = data?.listing?.value_usd;
  return { status: "ready", coins, retry, value: total == null ? null : Number(total) };
}
