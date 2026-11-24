"use client";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { lazy, Suspense, useId, useRef, useState } from "react";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { PieIcon } from "#web/components/blast-ui/Icons.tsx";
import { useWorkspace } from "./workspace-context";
import { PortfolioPending } from "./PortfolioPending";
import type { PanelInput } from "@blast/core/modules/social/blast-workspace/setup.ts";
import hostStyles from "./WorkspaceHost.module.css";
import styles from "./WorkspacePortfolio.module.css";

const PortfolioIdentity = lazy(() => import("./PortfolioData").then(module => ({ default: module.PortfolioIdentity })));

/** Finish dismissal before selecting a trade or opening the replacement confirmation. */
export function WorkspacePortfolio() {
  const { dispatch, presentation } = useWorkspace();
  const [open, setOpen] = useState(false);
  const pending = useRef<{ input: PanelInput; side: "buy" | "sell" } | null>(null);
  const heading = useId();
  function finish() {
    const request = pending.current;
    pending.current = null;
    if (!request) return;
    if (request.side === "buy") dispatch.openOnBuy(request.input);
    else dispatch.openOnSell(request.input);
  }
  return <>
    {/* One predictable destination (audit 25): the header's Portfolio always opens the Portfolio sheet; "Your portfolio" stays the coin's context tab. */}
    <Button variant="secondary" size="chip" type="button" className={styles.trigger} aria-label="Portfolio" aria-haspopup="dialog" aria-expanded={open} data-header-portfolio="" onClick={() => setOpen(true)}>
      <PieIcon /><span>Portfolio</span>
    </Button>
    <Sheet open={open} labelledBy={heading} className={`${hostStyles.tradeSheet} ${styles.drawer}`} onRequestClose={() => { pending.current = null; setOpen(false); }} onClosed={finish}
      initialFocus={() => document.querySelector<HTMLInputElement>('[data-workspace-portfolio-drawer] input[type="search"]')}>
      <SheetClose onClick={() => { pending.current = null; setOpen(false); }} />
      <SheetHeading id={heading} title="Portfolio" />
      <div data-workspace-portfolio-drawer="">
        {open && presentation.document_visible && <Suspense fallback={<PortfolioPending label="Opening portfolio" quickTrade />}>
          <PortfolioIdentity onTrade={(input, side) => { pending.current = { input, side }; setOpen(false); }} />
        </Suspense>}
      </div>
    </Sheet>
  </>;
}
