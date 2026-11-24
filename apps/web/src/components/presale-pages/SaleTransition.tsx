"use client";

import { useEffect, useState, type ReactNode } from "react";

import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import { cx } from "./cx";
import { SaleSkeleton } from "./SaleLoading";

/** Refresh the viewer's allocation before revealing a new lifecycle stage. */
export function SaleTransition({ sale, children, aside = false }: Readonly<{ sale: SocialPresaleDetail["presale"]; children: ReactNode; aside?: boolean }>) {
  const client = useAppQueryClient();
  const [shownPhase, setShownPhase] = useState(sale.phase);
  const changing = shownPhase !== sale.phase;
  useEffect(() => {
    if (!changing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const bridge = new Promise<void>((resolve) => { timer = setTimeout(resolve, 200); });
    const refresh = client.invalidateQueries({ queryKey: queryKeys.me.presaleViewer([sale.presale_id]), exact: true }, { cancelRefetch: false });
    void Promise.all([bridge, refresh]).then(() => { if (active) setShownPhase(sale.phase); });
    return () => { active = false; clearTimeout(timer); };
  }, [changing, client, sale.phase, sale.presale_id]);
  return <div aria-busy={changing || undefined} className={cx("sale-transition")} data-sale-transition={changing ? "loading" : "ready"}>
    <div className={cx("sale-transition-content")} inert={changing || undefined}>{children}</div>
    {changing ? <div className={cx("sale-transition-skeleton")} role="status">
      <span className="sr-only">{sale.phase === "trading" ? "Preparing trading and your claim…" : "Updating presale…"}</span>
      {aside ? <div className={cx("card side-box")}>
        <SkeletonText>Trading and your tokens</SkeletonText>
        <SkeletonText>Your claimable allocation</SkeletonText>
        <SkeletonText>Preparing your next action</SkeletonText>
      </div> : <SaleSkeleton />}
    </div> : null}
  </div>;
}
