"use client";

import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";

import { useSaleCommit } from "#web/components/social/feed-ui/shell-bridge.tsx";
import { useSocialAccount } from "#web/components/social/use-social-account.ts";

import { CspStyles } from "./csp-style";
import { useSaleDetail, useViewerPresalesRead } from "./presales-client";
import { SaleView, type SaleCommit, type SaleWatch } from "./SaleView";
import { ViewerPositionFeedback } from "./ViewerPositionFeedback";
import { SaleAside } from "./SaleAside";
import { SaleTransition } from "./SaleTransition";

/**
 * The sale page's main column with the signed-in viewer's own view of it
 * (followed backers, own commits) read in the browser; the server-rendered
 * HTML is the same for every reader. The sale itself is read again in the
 * browser after a commit and as its stage turns (`useSaleDetail`).
 */
export function SalePage({
  detail: served,
  nowMs,
  watch,
  commit,
}: Readonly<{
  detail: SocialPresaleDetail;
  nowMs: number;
  watch?: SaleWatch;
  commit?: SaleCommit;
}>) {
  const detail = useSaleDetail(served, nowMs);
  const viewer = useViewerPresalesRead([detail.presale.presale_id]);
  const entry = viewer.data?.[detail.presale.presale_id] ?? null;
  const { account } = useSocialAccount();
  // Under the shell's commit dialog, "Blast" opens it (UI-09/10's hand-off).
  const hostCommit = useSaleCommit();
  return (
    <>
      <CspStyles />
      <SaleTransition sale={detail.presale}>
        <SaleView
          commit={commit ?? hostCommit}
          detail={detail}
          me={account ? { avatar_url: account.avatar_url } : null}
          nowMs={nowMs}
          position={<ViewerPositionFeedback read={viewer} />}
          tradingClaims={detail.presale.phase === "trading" ? <SaleAside compact detail={detail} nowMs={nowMs} /> : null}
          refund={detail.presale.phase === "cancelled" && entry?.mine ? <SaleAside compact detail={detail} nowMs={nowMs} /> : null}
          viewerEntry={entry}
          watch={watch}
        />
      </SaleTransition>
    </>
  );
}
