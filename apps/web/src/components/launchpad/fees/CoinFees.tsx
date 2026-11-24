"use client";

import { useMemo, useRef, useState } from "react";

import { atCheckpoint, browserMarketDependencies } from "../blast-infra-browser";
import { useMarketPoll } from "../use-market-poll";
import { readFees, type FeesSource } from "./fees-client";
import { afterRead, INITIAL_FEES } from "./fees-model";
import { FeesView } from "./FeesView";

/**
 * The coin page's fees in the browser. It reads the launch's two fee ledgers through this
 * app's `/api/launchpad/market` route (which relays blast-infra's `/v1` answer), re-reads them
 * every 15 s while visible (`useMarketPoll`), and on request.
 */
export function CoinFees({ source }: Readonly<{ source: FeesSource }>) {
  const [state, setState] = useState(INITIAL_FEES);
  const [pending, setPending] = useState(false);
  const network = source.expected?.network ?? null;
  const deployment = source.expected?.deployment ?? null;
  const dependencies = useMemo(
    () => browserMarketDependencies(network && deployment ? { network, deployment } : null),
    [network, deployment],
  );
  // The latest read; an older one answering later is dropped.
  const ticket = useRef(0);
  const manualTicket = useRef(0);

  const refresh = (manual: boolean, at: number | null = null) => {
    const mine = ++ticket.current;
    const manualMine = manual ? ++manualTicket.current : null;
    if (manual) setPending(true);
    return readFees(source, atCheckpoint(dependencies, at)).then(outcome => {
      if (mine === ticket.current) setState(current => afterRead(current, outcome));
    }).catch(() => {
      if (mine === ticket.current) setState(current => afterRead(current, { kind: "failed", reason: "unavailable" }));
    }).finally(() => {
      if (manualMine === manualTicket.current) setPending(false);
    });
  };

  useMarketPoll({ key: source.launchId, onRefresh: (at) => void refresh(false, at) });

  return <FeesView launchId={source.launchId} state={state} units={source.units} pending={pending} onRefresh={() => void refresh(true)} />;
}
