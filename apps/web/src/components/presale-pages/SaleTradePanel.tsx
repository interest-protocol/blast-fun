"use client";

import { SwapLoading } from "#web/components/social/coins/SwapLoading.tsx";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import { tradesInApp } from "@blast/core/web/contracts/trades.ts";

import { cx } from "./cx";

const InlineCoinsHost = dynamic(() => import("#web/components/social/coins/CoinsHost.tsx").then((module) => module.CoinsHost), {
  loading: () => <SwapLoading />,
});

/** The shell keeps the mobile sheet; this panel retains its draft when the rail is hidden. */
export function SaleTradePanel({ sale }: Readonly<{ sale: SocialPresaleDetail["presale"] }>) {
  const [tabVisible, setTabVisible] = useState(true);
  const [desktop, setDesktop] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1220px)");
    const update = () => {
      setDesktop(media.matches);
      if (media.matches) setMounted(true);
    };
    update();
    const updateVisibility = () => setTabVisible(document.visibilityState !== "hidden");
    updateVisibility();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);
  if (!tradesInApp(sale.venue)) return <section className={cx("card side-box")}><div className={cx("side-h")}><h2>Trading</h2></div><p className={cx("plain")}>In-app trading is unavailable for <DexIdentity iconOnly venue={sale.venue} />.</p></section>;
  // The Coin board's ticket: "Buy {name}", then the shared swap form.
  return <section aria-label={`Trading form for ${sale.symbol}`} className={cx("card side-box sale-trade-panel")}>
    <div className={cx("side-h")}><h2>Buy {sale.name}</h2></div>
    {mounted ? <InlineCoinsHost key={sale.presale_id} inlineSale={sale} active={desktop && tabVisible} /> : <SwapLoading />}
  </section>;
}
