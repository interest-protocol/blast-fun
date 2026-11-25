"use client";

import { useMemo, useRef, useState } from "react";

import { atCheckpoint, browserMarketDependencies } from "../blast-infra-browser";
import { useTradeReads } from "../trade-reads";
import { readHoldersPage, type HoldersSource } from "./holders-client";
import { afterMore, afterRefresh, INITIAL_HOLDERS, showNewer, type HoldersOutcome } from "./holders-model";
import { HoldersView } from "./HoldersView";

const HOLDERS_GAP_MS = 15_000;
const HOLDERS_FALLBACK_MS = { live: 30_000, idle: 15_000 } as const;

/**
 * The coin page's Holders destination in the browser. It reads the native
 * holder snapshot through this app's `/api/launchpad/market` route (which
 * relays blast-infra's `/v1` answer) and pages through holders on request.
 * While visible it re-reads when the coin trades on the tab's market stream,
 * pinned to the trade's checkpoint and at most once per 15 s, and otherwise
 * every 30 s on a live, quiet stream or 15 s without one (`useTradeReads`).
 */
export function CoinHolders({ source, compact }: Readonly<{ source: HoldersSource; compact?: boolean }>) {
  const [state, setState] = useState(INITIAL_HOLDERS);
  const [pending, setPending] = useState<"refresh" | "more" | null>(null);
  const network = source.expected?.network ?? null;
  const deployment = source.expected?.deployment ?? null;
  const dependencies = useMemo(
    () => browserMarketDependencies(network && deployment ? { network, deployment } : null),
    [network, deployment],
  );
  // The latest first-page read; an older one answering later is dropped.
  const ticket = useRef(0);

  const refresh = async (manual: boolean, at: number | null = null): Promise<HoldersOutcome> => {
    const mine = ++ticket.current;
    if (manual) setPending("refresh");
    const outcome = await readHoldersPage(source, null, atCheckpoint(dependencies, at));
    if (mine === ticket.current) setState((current) => afterRefresh(current, outcome));
    if (manual) setPending((current) => (current === "refresh" ? null : current));
    return outcome;
  };

  const more = async () => {
    const cursor = state.view?.nextCursor;
    if (!cursor) return;
    setPending("more");
    const outcome = await readHoldersPage(source, cursor, dependencies);
    setState((current) => afterMore(current, cursor, outcome));
    setPending((current) => (current === "more" ? null : current));
  };

  useTradeReads({
    coinType: source.coinType,
    minGapMs: HOLDERS_GAP_MS,
    fallbackMs: HOLDERS_FALLBACK_MS,
    initial: true,
    read: (at) => void refresh(false, at),
  });

  return (
    <HoldersView
      compact={compact}
      state={state}
      symbol={source.symbol}
      decimals={source.decimals}
      pending={pending}
      onRefresh={() => void refresh(true)}
      onMore={() => void more()}
      onShowNewer={() => setState(showNewer)}
    />
  );
}
