import { useContext } from "react";
import { createPortal } from "react-dom";
import { CoinWorkspaceLayout } from "./WorkspaceLayout";
import { DEFAULT_WORKSPACE_LAYOUT, type WorkspaceLayout } from "@blast/core/modules/social/blast-workspace/workspace-layout-model.ts";
import { SkeletonBox, SkeletonRegion, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { TestPricingNotice } from "#web/components/social/TestPricingNotice.tsx";
import { useTestPricing } from "#web/components/social/test-pricing-context.tsx";
import { WorkspaceToolbarTarget } from "./frame-targets";
import { discoverOpensOnScreen } from "./discover-default";
import type { WorkspaceV1 } from "@blast/core/modules/social/blast-workspace/setup.ts";
import styles from "./WorkspaceHost.module.css";
import shellStyles from "#web/components/blast-ui/AppShell.module.css";
import boardStyles from "./WorkspaceLayout.module.css";
import signalStyles from "./WorkspaceSignals.module.css";
import { previewLayout, readWorkspacePreview, workspacePreview } from "./workspace-preview";

/**
 * Render saved geometry before live reads, without mounting any actionable asset content. The
 * header's controls and the focus board are drawn where they will land (owner, 2026-10-29: one
 * layout from the first frame, filled in place), so opening Blast mode never swaps arrangements.
 */
export function WorkspacePending({ snapshot, boot = false }: Readonly<{ snapshot?: WorkspaceV1; boot?: boolean }>) {
  const toolbarTarget = useContext(WorkspaceToolbarTarget);
  const { preview, focus, dataOpen, count } = pendingView(snapshot, boot);
  return <div className={styles.content} aria-busy="true" aria-label="Opening saved workspace">
    {toolbarTarget && <>
      {/* Before the saved workspace is read, Recent is assumed present, so a returning viewer's search never moves right. */}
      {createPortal(<ToolbarSkeleton saved={preview?.saved ?? true} />, toolbarTarget)}
      <StripSkeleton />
    </>}
    {boot && <StripSkeleton />}
    <div className={styles.layout} data-pending-layout="" data-data-open={String(dataOpen)} data-presentation={focus ? "focus" : "compare"}>
      {(boot || focus && !dataOpen) && <div data-pending-edge="" className={styles.dataEdge}><SkeletonBox className={styles.pendingEdge} /></div>}
      <div className={styles.workspaceMain}>
        <div className={styles.panels} data-pending-panels="" data-count={count} data-presentation={focus ? "focus" : "compare"}>
          {focus ? <BoardSkeleton layout={preview ? previewLayout(preview) : undefined} /> : Array.from({ length: count }, (_, index) => <div className={styles.pendingPanel} key={index}><PanelSkeletonParts /></div>)}
          {boot && <div hidden inert data-compare-placeholder=""><div className={styles.pendingPanel}><PanelSkeletonParts /></div></div>}
        </div>
      </div>
      {(boot || dataOpen) && <aside data-pending-discover="" hidden={!dataOpen} className={styles.data}><SkeletonText>{snapshot?.data.selected_view ?? "Data"}</SkeletonText></aside>}
    </div>
  </div>;
}

function pendingView(snapshot: WorkspaceV1 | undefined, boot: boolean) {
  const preview = snapshot ? workspacePreview(snapshot) : boot ? undefined : readWorkspacePreview();
  const focus = !preview || preview.presentation === "focus";
  // The live view's screen rule, so a laptop with Discover saved open opens on the rail from the first frame.
  const dataOpen = preview ? preview.discover && (!focus || discoverOpensOnScreen()) : false;
  const count = focus ? 1 : preview?.panels ?? 1;
  return { preview, focus, dataOpen, count };
}

/** An asset panel whose code is still loading: the same card, identity line, plot and actions; in focus, the board. */
export function PanelSkeleton({ focus = false }: Readonly<{ focus?: boolean }>) {
  if (focus) return <SkeletonRegion label="Opening asset panel"><BoardSkeleton /></SkeletonRegion>;
  return <SkeletonRegion className={styles.pendingPanel} label="Opening asset panel"><PanelSkeletonParts /></SkeletonRegion>;
}

function PanelSkeletonParts() {
  return <>
    <SkeletonText>Asset identity and price</SkeletonText>
    <SkeletonBox className={styles.pendingPlot} />
    <SkeletonText>Asset actions</SkeletonText>
  </>;
}

/** The activity strip's row under the header bar, in the strip's own box. */
export function StripSkeleton() {
  return <div className={signalStyles.strip} data-workspace-strip="" aria-hidden="true">
    <span className={signalStyles.source}><SkeletonText>Recent activity</SkeletonText></span>
  </div>;
}

/** The header bar's controls at their 36px chip height and in their order: coin, Recent, search, then Portfolio, the balance, Layout and settings. */
export function ToolbarSkeleton({ saved }: Readonly<{ saved: boolean }>) {
  const testPricing = useTestPricing();
  return <div className={styles.toolbar} data-pending-toolbar="">
    <div className={styles.panelTools}>
      <SkeletonBox className={`${styles.pendingTool} ${styles.pendingCoin}`} />
      {saved && <span data-pending-saved=""><SkeletonBox className={`${styles.pendingTool} ${styles.pendingSaved}`} /></span>}
    </div>
    <SkeletonBox className={`${styles.pendingTool} ${styles.pendingSearch}`} />
    <span className={styles.toolbarSpacer} />
    <SkeletonBox className={`${styles.pendingTool} ${styles.pendingPortfolio}`} />
    <TestPricingNotice compact enabled={testPricing} />
    <SkeletonBox className={`${styles.pendingTool} ${shellStyles.accountBalance}`} />
    <SkeletonBox className={`${styles.pendingTool} ${styles.pendingLayout}`} />
    <SkeletonBox className={`${styles.pendingTool} ${styles.pendingIcon}`} />
  </div>;
}

/** The focus board's three cards in the board's own grid: chart, the ticket column (ticket and Flow), holders. No splitters: nothing here acts. */
function BoardSkeleton({ layout = DEFAULT_WORKSPACE_LAYOUT }: Readonly<{ layout?: WorkspaceLayout }>) {
  return <CoinWorkspaceLayout pendingLayout={layout} sections={{
    chart: <section>
      <SkeletonText>Asset identity and price</SkeletonText>
      <SkeletonBox className={styles.pendingPlot} />
    </section>,
    trade: <section>
      <SkeletonBox className={boardStyles.pendingTicket} />
      <SkeletonBox className={boardStyles.pendingFlow} />
    </section>,
    activity: <section><SkeletonText>Holders and trades</SkeletonText></section>,
    details: null,
  }} />;
}
