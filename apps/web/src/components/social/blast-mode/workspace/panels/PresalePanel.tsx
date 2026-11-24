"use client";
import { Button } from "#web/components/blast-ui/Button.tsx";

import {
  type ReactNode,
  useCallback,
  useContext,
  useState,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type { SocialPresaleDetail, SocialPresaleViewerEntry } from "@blast/core/web/contracts/presales.ts";
import { normalizeStructTag } from "@mysten/sui/utils";
import { WorkspacePresaleDockContext } from "../presale-dock-context";
import { PanelIdentity, PanelTabs, SaleStage, TradingStage, type PanelTab } from "./PanelChrome";
import { PresaleHero, PresaleSummary } from "./PresaleSummary";
import { presaleStage, presaleStageLine } from "./presale-stage";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import type { CommitKit } from "#web/components/social/commit/commit-kit.ts";
import type { ClaimPath } from "../../../claim/claims";
import type { ActionPreference } from "../ActionConfirmation";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { PresaleAsset, PresaleReads } from "./presale-reads";
import { useCoinRead } from "./use-coin-read";
import { PresaleContent, PresaleAmount, PresaleReadProblem } from "./PresaleContent";
import { PresaleCommit } from "./PresaleCommit";
import { PresaleClaim } from "./PresaleClaim";
import { workspaceScrollOwner } from "../scroll-owner";
import styles from "./PresalePanel.module.css";
import focusStyles from "./FocusPanel.module.css";
import { WorkspaceContext } from "../workspace-context";
import { RaiseChart } from "#web/components/presale-pages/RaiseChart.tsx";
import { CoinWorkspaceLayout } from "../WorkspaceLayout";
import { ProjectLinks } from "./ProjectLinks";
import { CoinPosts } from "./CoinPosts";
import { PresaleFocusDetails } from "./PresaleFocusDetails";

export type PresalePanelProps = Readonly<{
  focus?: boolean;
  panel_id: string;
  asset: PresaleAsset;
  presale_setup: PanelSetup["presale"];
  onSetupChange: (setup: PanelSetup["presale"]) => void;
  effective_visibility: boolean;
  actions: Readonly<{
    commit: CommitKit | null;
    confirmation?: ActionPreference;
    authenticated: boolean;
    actor_key: string;
    signIn: () => void;
    claimPath?: ClaimPath;
  }>;
  reads: PresaleReads;
  onRemove?: () => void;
  onTradingAvailable?: () => void;
  inspectHistory?: boolean;
}>;
/** Blast mode's presale views are a fixed pair; any other saved tab (Commits, Posts, …) reads as Sale without being rewritten. */
const TABS = [
  ["overview", "Sale", "sale"],
  ["people", "Backers", "people"],
] as const satisfies readonly PanelTab<NonNullable<PanelSetup["presale"]["tabs"]["selected"]>>[];
type PresaleView = (typeof TABS)[number][0];
const presaleView = (selected: PanelSetup["presale"]["tabs"]["selected"]): PresaleView => (selected === "people" ? "people" : "overview");

export function PresalePanel({
  focus: focusOverride,
  panel_id,
  asset: input,
  presale_setup: setup,
  onSetupChange,
  effective_visibility: visible,
  actions,
  reads,
  onRemove,
  onTradingAvailable,
  inspectHistory = false,
}: PresalePanelProps) {
  const workspace = useContext(WorkspaceContext);
  const focus = focusOverride ?? workspace?.snapshot.presentation === "focus";
  const prefix = useId();
  const dock = useContext(WorkspacePresaleDockContext);
  const { chain, network, coin_type, presale_id } = input;
  const asset = useMemo(
    () => ({
      chain,
      network,
      coin_type: normalizeStructTag(coin_type),
      presale_id,
    }),
    [chain, network, coin_type, presale_id],
  );
  const key = `${asset.chain}:${asset.network}:${asset.coin_type}:${asset.presale_id ?? ""}`;
  const load = useCallback(
    (signal: AbortSignal) => reads.detail(asset, signal),
    [asset, reads],
  );
  const contextVisible = dock?.activeId === panel_id;
  const effectiveVisible = visible || contextVisible;
  // Relative times ("closes in 4h 12m") are measured when each answer arrives, so they move with the live read.
  const [observedAt, setObservedAt] = useState(Date.now);
  const read = useCoinRead(effectiveVisible, key, load, () => setObservedAt(Date.now()));
  const loadViewer = useCallback(
    (signal: AbortSignal) => reads.viewer(asset, signal),
    [asset, reads],
  );
  const viewer = useCoinRead(
    effectiveVisible && actions.authenticated,
    `${key}:${actions.actor_key}`,
    loadViewer,
  );
  const detail = matchingPresale(read.value, asset);
  const viewerEntry = actions.authenticated && viewer.status === "ready" ? viewer.value : null;
  const priorPhase = useRef<string | null>(null);
  useEffect(() => {
    if (
      visible &&
      read.status === "ready" &&
      detail?.presale.phase === "trading" &&
      (!inspectHistory ||
        (priorPhase.current !== null && priorPhase.current !== "trading"))
    ) {
      onTradingAvailable?.();
    }
    if (read.status === "ready" && detail)
      priorPhase.current = detail.presale.phase;
  }, [visible, read.status, detail, onTradingAvailable, inspectHistory]);
  const view = presaleView(setup.tabs.selected);
  const { body, beginNavigation, rememberScroll } = usePresaleNavigation({
    key,
    visible,
    pending: read.status === "pending",
    view,
    setup,
    onSetupChange,
  });
  const layout = presalePanelLayout(focus);
  const summary = (<section className={layout.summary} aria-label={layout.summaryLabel}>
      {/* Focus view's header already carries raised, target and backers. */}
      {!focus && <PresaleHero
        detail={detail}
        pending={read.status === "pending"}
        viewer={viewerEntry}
        compact={view !== "overview"}
      />}
      <div
        ref={body}
        className={styles.body}
        data-scroll-fade=""
        id={`${prefix}-content`}
        role={layout.role}
        tabIndex={0}
        aria-labelledby={focus ? undefined : `${prefix}-${view}`}
        onWheel={beginNavigation}
        onPointerDown={beginNavigation}
        onTouchStart={beginNavigation}
        onKeyDown={beginNavigation}
        onScroll={(event) => rememberScroll(event.currentTarget.scrollTop)}
      >
        {focus && <PresaleFundingChart id={`${prefix}-funding-chart`} detail={detail} status={read.status} now={observedAt} />}
        <PresaleReadContent read={read} detail={detail} view={focus ? "overview" : view} now={observedAt} compact={focus} />
      </div>
      </section>);
  const trade = (<section className={layout.trade} data-trade-open="true" aria-label={layout.tradeLabel}>
      <PresaleTradeHeading focus={focus} detail={detail} />
      <PresalePosition detail={detail} viewer={viewer} actions={actions} visible={visible} />
      <PresaleCommit
        key={`${key}:${actions.actor_key}`}
        yourCommit={yourCommit(detail, viewerEntry, focus)}
        asset={asset}
        setup={setup}
        onSetupChange={onSetupChange}
        visible={visible}
        actions={actions}
        detail={detail}
        detail_status={read.status}
      />
      {focus && <PresaleFocusDetails detail={detail} pending={read.status === "pending"} visible={visible} />}
      </section>);
  const allocation = <section className={focusStyles.position} aria-label="Your allocation"><h2>Your allocation</h2><PresaleAllocation detail={detail} viewer={viewer} actions={actions} /></section>;
  return <div className={styles.panel} data-focus={focus} data-presale-panel={panel_id}>
    <PresaleHeader asset={asset} detail={detail} now={observedAt} onRemove={focus ? undefined : onRemove}
      metrics={focus ? <PresaleMetrics detail={detail} pending={read.status === "pending"} commitment={<PresaleCommitmentMetric detail={detail} viewer={viewer} actions={actions} />} /> : null}
      tabs={presaleTabs(focus, view, setup, prefix, onSetupChange)} />
    {focus ? <CoinWorkspaceLayout presale detailsFallback={allocation} sections={{
      chart: summary,
      activity: <PresaleMarketActivity asset={asset} reads={reads} visible={visible} participants={<PresaleReadContent read={read} detail={detail} view="people" now={observedAt} />} />,
      trade,
      details: allocation,
    }} /> : <div className={styles.presentation}>{summary}{trade}</div>}
  </div>;
}

function presaleTabs(focus: boolean, view: PresaleView, setup: PanelSetup["presale"], prefix: string, onSetupChange: PresalePanelProps["onSetupChange"]) {
  if (focus) return null;
  return <PanelTabs tabs={TABS} selected={view} prefix={prefix} label="Presale views"
    // Legacy saved enabled lists may predate the fixed pair of views.
    onSelect={selected => onSetupChange({ ...setup, tabs: { selected, enabled: setup.tabs.enabled.includes(selected) ? setup.tabs.enabled : [...setup.tabs.enabled, selected] } })} />;
}

function presalePanelLayout(focus: boolean) {
  return focus
    ? { summary: focusStyles.funding, trade: focusStyles.trade, summaryLabel: "Raise progress", tradeLabel: "Presale commitment", role: undefined }
    : { summary: styles.summaryRegion, trade: styles.commitRegion, summaryLabel: undefined, tradeLabel: undefined, role: "tabpanel" };
}

/** This account's commitment so far: an amount, "None yet" once the read confirms there is none, or "—" while unknown. */
/** This account's commitment, only once the viewer read confirms one; the tray says nothing otherwise. */
function yourCommit(detail: SocialPresaleDetail | null, entry: SocialPresaleViewerEntry | null, focus: boolean) {
  if (focus || !detail || !entry?.mine) return undefined;
  return <PresaleAmount compact atoms={entry.mine.commitment_atoms} decimals={detail.presale.quote_decimals} symbol={detail.presale.quote_symbol} label="Your commitment" />;
}

function matchingPresale(
  detail: SocialPresaleDetail | null,
  asset: PresaleAsset,
) {
  if (!detail || detail.presale.presale_id !== asset.presale_id) return null;
  try {
    return normalizeStructTag(detail.presale.sale_token) === asset.coin_type
      ? detail
      : null;
  } catch {
    return null;
  }
}

function PresaleHeader({
  asset,
  detail,
  now,
  onRemove,
  tabs,
  metrics,
}: Readonly<{
  asset: PresaleAsset;
  detail: SocialPresaleDetail | null;
  now: number;
  onRemove?: PresalePanelProps["onRemove"];
  tabs: ReactNode;
  metrics?: ReactNode;
}>) {
  const line = detail ? presaleStageLine(detail.presale, now) : null;
  const stage = !detail || !line ? (
    <SaleStage>Presale</SaleStage>
  ) : line.next === null ? (
    <TradingStage venue={detail.presale.venue} />
  ) : (
    <SaleStage lead={line.lead}><b>{line.next}</b></SaleStage>
  );
  return <><PanelIdentity stable socials={metrics ? <ProjectLinks metadata={detail?.presale.metadata} /> : null} metrics={metrics} coinType={asset.coin_type} network={asset.network} symbol={detail?.presale.symbol} name={detail?.presale.name} icon={detail?.presale.icon_url} verified={detail?.presale.verified_team === true} stage={stage} tabs={tabs} />{onRemove && <Button variant="secondary" size="sm" type="button"  onClick={onRemove} aria-label={`Remove ${detail?.presale.symbol ?? "presale"} panel`}>×</Button>}</>;
}

function PresaleReadContent({
  read,
  detail,
  view,
  now,
  compact = false,
}: Readonly<{
  read: Pick<ReturnType<typeof useCoinRead>, "status" | "retry">;
  detail: SocialPresaleDetail | null;
  view: PresaleView;
  now: number;
  compact?: boolean;
}>) {
  if (read.status === "pending") {
    return (
      <div role="status" aria-label="Loading presale">
        <SkeletonText>Presale terms, commitments and backers</SkeletonText>
      </div>
    );
  }
  if (read.status === "error")
    return <PresaleReadProblem name="Presale" retry={read.retry} />;
  if (!detail)
    return <PresaleUnavailable label="information" retry={read.retry} />;
  return (
    <>
      {!detail.terms && <PresaleUnavailable label="terms" retry={read.retry} />}
      {view === "overview" && <PresaleSummary detail={detail} now={now} compact={compact} />}
      <PresaleContent detail={detail} tab={view} />
    </>
  );
}

function PresaleUnavailable({ label, retry }: Readonly<{
  label: "terms" | "information";
  retry: () => void;
}>) {
  return (
    <p role="status">
      Presale {label} {label === "terms" ? "are" : "is"} unavailable. Your setup is kept.{" "}
      <Button variant="secondary" size="sm"  type="button" onClick={retry}>
        Retry presale
      </Button>
    </p>
  );
}

function usePresaleNavigation({
  key,
  visible,
  pending,
  view,
  setup,
  onSetupChange,
}: Readonly<{
  key: string;
  visible: boolean;
  pending: boolean;
  view: PresaleView;
  setup: PresalePanelProps["presale_setup"];
  onSetupChange: PresalePanelProps["onSetupChange"];
}>) {
  const body = useRef<HTMLDivElement>(null);
  const restored = useRef("");
  const navigating = useRef(false);
  const navKey = `${key}:${visible}:${view}`;
  const rememberScroll = (scrollTop: number) => {
    if (restored.current !== navKey) return;
    onSetupChange({
      ...setup,
      navigation: { ...setup.navigation, scroll_top: scrollTop },
    });
  };
  const rememberOwnerScroll = useEffectEvent(rememberScroll);
  useLayoutEffect(() => {
    if (!visible || pending || restored.current === navKey || !body.current)
      return;
    navigating.current = false;
    workspaceScrollOwner(body.current).scrollTop = setup.navigation.scroll_top;
    restored.current = navKey;
  }, [visible, pending, navKey, setup.navigation.scroll_top]);
  useEffect(() => {
    if (!visible || !body.current) return;
    const owner = workspaceScrollOwner(body.current);
    if (owner === body.current) return;
    const remember = () => {
      if (navigating.current) rememberOwnerScroll(owner.scrollTop);
    };
    owner.addEventListener("scroll", remember);
    return () => owner.removeEventListener("scroll", remember);
  }, [visible, navKey]);
  const beginNavigation = () => {
    navigating.current = true;
  };
  return { body, beginNavigation, rememberScroll };
}

function PresalePosition({ detail, viewer, actions, visible }: Readonly<{
  detail: SocialPresaleDetail | null;
  viewer: ReturnType<typeof useCoinRead<Awaited<ReturnType<PresalePanelProps["reads"]["viewer"]>>>>;
  actions: PresalePanelProps["actions"];
  visible: boolean;
}>) {
  if (!actions.authenticated || !detail || ["pending", "open"].includes(detail.presale.phase)) return null;
  return <PresaleClaim detail={detail} entry={viewer.value} status={viewer.status} retry={viewer.retry} actions={actions} visible={visible} />;
}

function PresaleMarketActivity({ asset, reads, visible, participants }: Readonly<{ asset: PresaleAsset; reads: PresaleReads; visible: boolean; participants: ReactNode }>) {
  const [tab, setTab] = useState("Participants");
  const id = useId();
  return <section className={focusStyles.activity} aria-label="Presale participation">
    <div role="group" aria-label="Presale context" className={focusStyles.tabs}>{["Participants", "Posts"].map(label => <Button variant="segment" size="sm" type="button" key={label} aria-pressed={tab === label} aria-controls={id} onClick={() => setTab(label)}>{label}</Button>)}</div>
    <div id={id} className={focusStyles.activityBody}>{tab === "Participants" ? participants : <CoinPosts asset={asset} reads={reads} visible={visible} />}</div>
  </section>;
}

function PresaleMetrics({ detail, pending, commitment }: Readonly<{ detail: SocialPresaleDetail | null; pending: boolean; commitment: ReactNode }>) {
  const sale = detail?.presale;
  return <dl className={focusStyles.metrics}>
    <div><dt>Raised</dt><dd>{sale ? <PresaleAmount compact atoms={sale.raised_atoms} decimals={sale.quote_decimals} symbol={sale.quote_symbol} label="Raised" /> : pending ? <SkeletonText>0,000 SUI</SkeletonText> : "—"}</dd></div>
    <div><dt>Target</dt><dd>{sale ? <PresaleAmount compact atoms={sale.target_atoms} decimals={sale.quote_decimals} symbol={sale.quote_symbol} label="Target" /> : "—"}</dd></div>
    <div><dt>Participants</dt><dd>{sale?.participants.toLocaleString("en-US") ?? "—"}</dd></div>
    {commitment}
  </dl>;
}

function PresaleCommitmentMetric({ detail, viewer, actions }: Readonly<{
  detail: SocialPresaleDetail | null; viewer: ReturnType<typeof useCoinRead<SocialPresaleViewerEntry | null>>; actions: PresalePanelProps["actions"];
}>) {
  let value: ReactNode;
  if (!actions.authenticated) value = <Button variant="ghost" size="sm" className={focusStyles.positionAction} type="button" onClick={actions.signIn}>Sign in</Button>;
  else if (viewer.status === "pending") value = <span role="status" aria-label="Loading your commitment"><SkeletonText>000 USDC</SkeletonText></span>;
  else if (viewer.status === "error") value = <Button variant="ghost" size="sm" className={focusStyles.positionAction} type="button" onClick={viewer.retry}>Retry allocation</Button>;
  else if (!viewer.value || !detail) value = "Unavailable";
  else value = <PresaleAmount compact atoms={viewer.value.mine?.commitment_atoms ?? "0"} decimals={detail.presale.quote_decimals} symbol={detail.presale.quote_symbol} label="Your commitment across linked wallets" />;
  return <div><dt>Your commitment · all wallets</dt><dd>{value}</dd></div>;
}

function PresaleAllocation({ detail, viewer, actions }: Readonly<{
  detail: SocialPresaleDetail | null;
  viewer: ReturnType<typeof useCoinRead<SocialPresaleViewerEntry | null>>;
  actions: PresalePanelProps["actions"];
}>) {
  if (!actions.authenticated) return <Button variant="secondary" size="sm"  type="button" onClick={actions.signIn}>Sign in to see your allocation</Button>;
  if (viewer.status === "pending") return <SkeletonText>Your commitment and allocation</SkeletonText>;
  if (viewer.status === "error") return <PresaleReadProblem name="Your allocation" retry={viewer.retry} />;
  if (!viewer.value || !detail) return <p>Your allocation is unavailable.</p>;
  const mine = viewer.value.mine;
  if (!mine) return <p>You haven’t participated in this presale.</p>;
  const sale = detail.presale;
  return <><dl className={focusStyles.facts}>
    <div><dt>Committed · all linked wallets</dt><dd><PresaleAmount atoms={mine.commitment_atoms} decimals={sale.quote_decimals} symbol={sale.quote_symbol} label="Your commitment" /></dd></div>
    <div><dt>Unclaimed · active Blast wallet</dt><dd><PresaleAmount atoms={mine.claimable_tokens} decimals={sale.sale_decimals} symbol={sale.symbol} label="Your unclaimed allocation" /></dd></div>
    <div><dt>Already refunded · all linked wallets</dt><dd><PresaleAmount atoms={mine.refund_atoms} decimals={sale.quote_decimals} symbol={sale.quote_symbol} label="Already refunded" /></dd></div>
  </dl></>;
}

function PresaleFundingChart({ id, detail, status, now }: Readonly<{ id: string; detail: SocialPresaleDetail | null; status: string; now: number }>) {
  if (status !== "ready" || !detail) return null;
  if (!detail.raise.points.length) {
    // Empty only when the sale itself says nobody has committed; otherwise the history is missing, not empty.
    if (detail.presale.participants > 0) return <EmptyState className={focusStyles.chartEmpty} title="Funding history is unavailable" />;
    const stage = presaleStage(detail.presale, now).label;
    const title = stage === "Upcoming" ? "Not open yet" : stage === "Live" ? "No commitments yet" : "No commitments";
    return <EmptyState className={focusStyles.chartEmpty} title={title}>{stage === "Upcoming" || stage === "Live" ? "The funding chart starts with the first commitment." : null}</EmptyState>;
  }
  return <RaiseChart stretch id={id} detail={detail} marks={[]} overlays={{ mine: false, following: false, big: false, thesis: false }} nowMs={now} />;
}
function PresaleTradeHeading({ focus, detail }: Readonly<{ focus: boolean; detail: SocialPresaleDetail | null }>) {
  if (!focus) return null;
  const phase = detail?.presale.phase;
  const title = phase === "open" || phase === "pending" ? "Commit to" : "Your participation in";
  return <h2>{title} {detail?.presale.symbol ?? "presale"}</h2>;
}
