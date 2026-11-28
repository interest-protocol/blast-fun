"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { StandaloneCurveTrade } from "#web/components/launchpad/trade/CoinTrade.tsx";
import { CurveTradeUnavailable } from "#web/components/launchpad/trade/CurveTradeRail.tsx";
import type { CurveTradeSetup } from "#web/components/launchpad/trade/server-availability.ts";
import { TradeSheet } from "#web/components/launchpad/trade/TradeSheet.tsx";
import type { SocialTradeCoin } from "@blast/core/modules/social/contracts/trades.ts";

/** One Home Buy on a coin still on its curve: the launch, and the row's coin. */
export type CurveBuy = Readonly<{ launchId: string; coin: SocialTradeCoin }>;
/** Each press is a new request, so a second press on the same coin reopens its sheet. */
export type CurveBuyRequest = Readonly<{ buy: CurveBuy; seq: number }>;

const MISMATCHED = "This coin can’t be bought here. Open its page to trade.";

/**
 * Home's Buy sheet for coins on their curve: the coin page's curve rail, with its amount presets.
 * Each launch keeps one rail. A rail stays mounted while its sheet is open or while one of its
 * trades is unresolved, so closing the sheet or opening another coin never loses a pending buy;
 * a closed rail with nothing held is dropped. When the open coin graduates, `onGraduated` hands
 * it to the swap; a closed one is just dropped.
 */
export function CurveBuySheet({ request, setup, onGraduated }: Readonly<{
  request: CurveBuyRequest;
  setup: CurveTradeSetup;
  onGraduated: (coin: SocialTradeCoin) => void;
}>) {
  const [seen, setSeen] = useState<number | null>(null);
  const [coins, setCoins] = useState<Readonly<Record<string, SocialTradeCoin>>>({});
  const [shown, setShown] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [placement, setPlacement] = useState<HTMLDivElement | null>(null);
  if (request.seq !== seen) {
    const { launchId, coin } = request.buy;
    setSeen(request.seq);
    setCoins(current => ({ ...current, [launchId]: coin }));
    setShown(launchId);
    setOpen(true);
  }

  function graduated(launchId: string) {
    const coin = coins[launchId];
    setCoins(current => Object.fromEntries(Object.entries(current).filter(([id]) => id !== launchId)));
    if (launchId !== shown) return;
    setShown(null);
    if (open && coin) {
      setOpen(false);
      onGraduated(coin);
    }
  }

  function heldChange(launchId: string, value: boolean) {
    setHeld(current => {
      if (current.has(launchId) === value) return current;
      const next = new Set(current);
      if (value) next.add(launchId);
      else next.delete(launchId);
      return next;
    });
  }

  const { availability } = setup;
  const available = availability.status === "available" ? availability.config : null;
  const mounted = Object.entries(coins).filter(([id]) => id === shown || held.has(id));
  const title = shown && coins[shown] ? `Buy $${coins[shown].symbol}` : "Buy";
  return <>
    <TradeSheet open={open} title={title} onClose={() => setOpen(false)} onClosed={() => setShown(null)}>
      {availability.status === "available" ? <div ref={setPlacement} /> : <CurveTradeUnavailable reason={availability.reason} />}
    </TradeSheet>
    {available ? mounted.map(([launchId, coin]) => (
      <CurveRail key={launchId} placement={launchId === shown ? placement : null}>
        <StandaloneCurveTrade
          config={available}
          connection={setup.connection}
          launchId={launchId}
          coinType={coin.coin_type}
          live
          onInvalidate={keepHomeLive}
          onMigrated={() => graduated(launchId)}
          onHeldChange={value => heldChange(launchId, value)}
          fallback={<CurveTradeUnavailable reason={MISMATCHED} />}
        />
      </CurveRail>
    )) : null}
  </>;
}

/** Home's rows follow the market feed on their own; the rail refreshes its own curve and wallet reads. */
function keepHomeLive() {}

/** One rail's own element: inside the open sheet when it is the one shown, otherwise kept off the page. */
function CurveRail({ placement, children }: Readonly<{ placement: HTMLElement | null; children: ReactNode }>) {
  const [host] = useState(() => document.createElement("div"));
  useEffect(() => {
    if (placement) placement.replaceChildren(host);
    else host.remove();
  }, [placement, host]);
  return createPortal(children, host);
}
