"use client";

import { holderRows } from "./holder-rows.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";

import { useCallback, useContext, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { bxPx, bxSigned, bxUsd, NO_VALUE } from "@blast/core/web/format.ts";
import { useRelationTag, useViewerStateStore } from "#web/components/social/ViewerState.tsx";
import type { HomeHolderPosition, HomeHoldersPage } from "@blast/core/web/contracts/coin-market.ts";
import { fetchCoinHolders } from "./coin-market-reads";
import { ClearFollowingOnlyContext, FollowingOnlyContext } from "./panel-context";
import { compactFigure } from "#web/lib/market-format.ts";
import { walletBalance, walletCoin, terminalUsd } from "./coin-facts";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { ActorAvatar } from "../ActorCell";
import { actorIdentity, actorKey } from "../actor-identity";
import { NoRows, PanelEmptyState } from "./PanelEmptyState";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { WorkspaceContext } from "../workspace-context";
import { PortfolioIdentity } from "../PortfolioData";
import { CoinInformation } from "./CoinInformation";
import { PORTFOLIO_CONTEXT_EVENT } from "../portfolio-context";
import { CoinPosts } from "./CoinPosts";
import { CurveHolders, CurveTheses, CurveTrades, useCurveListLaunch } from "./CurveLaunchLists";
import { CoinWorkspaceLayout, useWorkspaceSectionVisible } from "../WorkspaceLayout";
import { CoinPnlMetric } from "./CoinPnlMetric";
import { useCoinRead, useCoinWalletRead } from "./use-coin-read";
import type { CoinPanelProps } from "./CoinPanel";
import type { CoinRecord } from "./coin-reads";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import styles from "./FocusPanel.module.css";
import holderStyles from "./CoinHolders.module.css";

type FocusContextProps = Pick<CoinPanelProps, "asset" | "actions" | "reads" | "coin_setup" | "onSetupChange"> & Readonly<{ coin: CoinRecord | null; coinPending?: boolean; visible: boolean; activity: ReactNode }>;

export function CoinFocusWorkspace({ chart, trade, ...props }: FocusContextProps & Readonly<{ chart: ReactNode; trade: ReactNode }>) {
  const activityVisible = useWorkspaceSectionVisible("activity");
  const { visible } = props;
  const selected = props.coin_setup.tabs.selected;
  const [personal, setPersonal] = useState<{ source: typeof selected; tab: "portfolio" | "info" | null }>(() => ({ source: selected, tab: null }));
  // Explicit research actions in Discover take precedence over the personal tab.
  const personalTab = personal.source === selected ? personal.tab : null;
  const setPersonalTab = useCallback((tab: "portfolio" | "info" | null) => setPersonal({ source: selected, tab }), [selected]);
  const selectActivity = () => setPersonalTab("portfolio");
  return <CoinWorkspaceLayout onActivitySelect={selectActivity} sections={{
    chart,
    trade,
    activity: <CoinFocusContext {...props} personalTab={personalTab} onPersonalTab={setPersonalTab} visible={visible && activityVisible} />,
    details: null,
  }} />;
}

type PersonalContextTab = "portfolio" | "info";
type ContextTab = PersonalContextTab | "trades" | "holders" | "posts";
type ContextProps = FocusContextProps & Readonly<{ personalTab: PersonalContextTab | null; onPersonalTab: (tab: PersonalContextTab | null) => void }>;

/**
 * Who holds and trades the coin (BlastMode.dc.html): Holders · Trades · Theses ·
 * Portfolio · coin info in one segmented row, with Following only beside the
 * lists it filters and With thesis beside the holders. Holders is the board's
 * default view.
 */
function CoinFocusContext(props: ContextProps) {
  const { coin, coin_setup: setup, onSetupChange, personalTab, onPersonalTab, asset, reads, visible } = props;
  const tab: ContextTab = personalTab ?? (setup.tabs.selected === "activity" ? "trades" : setup.tabs.selected === "posts" ? "posts" : "holders");
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const [followingOnly, setFollowingOnly] = useState(false);
  const [withThesis, setWithThesis] = useState(false);
  const store = useViewerStateStore();
  useEffect(() => {
    const element = section.current;
    let frame = 0;
    const open = () => {
      onPersonalTab("portfolio");
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => document.getElementById(contextTabId(id, "portfolio"))?.focus({ preventScroll: true }));
    };
    element?.addEventListener(PORTFOLIO_CONTEXT_EVENT, open);
    return () => { cancelAnimationFrame(frame); element?.removeEventListener(PORTFOLIO_CONTEXT_EVENT, open); };
  }, [id, onPersonalTab]);
  const select = (selected: ContextTab) => {
    if (selected === "portfolio" || selected === "info") { onPersonalTab(selected); return; }
    onPersonalTab(null);
    const saved: "people" | "activity" | "posts" = selected === "holders" ? "people" : selected === "trades" ? "activity" : "posts";
    onSetupChange({ ...setup, tabs: { ...setup.tabs, selected: saved, enabled: [...new Set([...setup.tabs.enabled, saved])] } });
  };
  const loadTheses = useCallback((signal: AbortSignal) => reads.posts?.(asset, null, signal) ?? Promise.resolve(null), [reads, asset]);
  const theses = useCoinRead(visible && !!reads.posts && !!asset.presale_id && asset.network === "mainnet", `theses:${asset.network}:${asset.coin_type}`, loadTheses);
  const counts = { holders: coin?.holders ?? null, theses: theses.value?.total ?? null };
  const curveLaunch = useCurveListLaunch(asset, coin, visible) ?? null;
  // The curve lists are the coin page's: Following only and With thesis filter the home lists alone.
  const filterable = curveLaunch === null && (tab === "holders" || tab === "trades");
  return <section ref={section} className={styles.activity} aria-label={`Who holds and trades ${coin?.symbol ?? "this coin"}`} data-portfolio-context="">
    <div className={styles.contextHead}>
      <ContextTabs id={id} selected={tab} counts={counts} onSelect={select} />
      <span className={styles.contextSpacer} />
      <ContextFilters tab={tab} filterable={filterable} store={store} followingOnly={followingOnly} setFollowingOnly={setFollowingOnly} withThesis={withThesis} setWithThesis={setWithThesis} />
    </div>
    <div id={`${id}-body`} role="tabpanel" aria-labelledby={contextTabId(id, tab)} tabIndex={0} className={styles.activityBody} data-context-view={tab}>
      <FollowingOnlyContext value={!!store && followingOnly && filterable}>
        <ClearFollowingOnlyContext value={() => setFollowingOnly(false)}>
          <ContextBody {...props} tab={tab} withThesis={withThesis} curveLaunch={curveLaunch} />
        </ClearFollowingOnlyContext>
      </FollowingOnlyContext>
    </div>
  </section>;
}

function contextTabId(id: string, tab: ContextTab) {
  return `${id}-${tab}`;
}

/**
 * Holders · Trades · Theses · Your portfolio · Info as the shared segmented tablist. A narrow card scrolls it
 * sideways with no scrollbar, so each end fades while more tabs lie past it (audit BM-02). "Info" stays short
 * whatever the ticker's length; the card already names the coin.
 */
function ContextTabs({ id, selected, counts, onSelect }: Readonly<{ id: string; selected: ContextTab; counts: Readonly<{ holders: number | null; theses: number | null }>; onSelect: (tab: ContextTab) => void }>) {
  const count = (value: number | null) => value === null ? null : <span className={styles.tabCount}>{compactFigure(String(value), 0)}</span>;
  const tabs = [
    ["holders", <span key="holders">Holders {count(counts.holders)}</span>],
    ["trades", "Trades"],
    ["posts", <span key="posts">Theses {count(counts.theses)}</span>],
    ["portfolio", "Your portfolio"],
    ["info", "Info"],
  ] as const;
  const listId = `${id}-tabs`;
  useEffect(() => {
    const list = document.getElementById(listId);
    const all = list?.querySelectorAll<HTMLElement>("[role=tab]");
    const first = all?.[0], last = all?.[all.length - 1];
    if (!list || !first || !last || typeof IntersectionObserver === "undefined") return;
    // A tab not fully in view means more tabs lie past that end (rootMargin absorbs sub-pixel widths).
    const observer = new IntersectionObserver(entries => {
      for (const { target, intersectionRatio } of entries) list.toggleAttribute(target === first ? "data-more-start" : "data-more-end", intersectionRatio < 1);
    }, { root: list, threshold: 1, rootMargin: "1px" });
    observer.observe(first);
    observer.observe(last);
    return () => observer.disconnect();
  }, [listId]);
  useEffect(() => {
    // Keep the selected tab clear of the fades, on selection and when the card narrows; scrolls the row only, never the page.
    const list = document.getElementById(listId);
    if (!list) return;
    const reveal = () => {
      const tab = list.querySelector("[aria-selected=true]");
      if (!tab || list.scrollWidth <= list.clientWidth) return;
      const pad = parseFloat(getComputedStyle(list).scrollPaddingInlineStart) || 0;
      const room = list.getBoundingClientRect(), own = tab.getBoundingClientRect();
      const shift = Math.min(0, own.left - room.left - pad) || Math.max(0, own.right - room.right + pad);
      if (shift) list.scrollLeft += shift;
    };
    reveal();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [listId, selected]);
  return <Segmented tabs size="sm" id={listId} label="Market context" className={styles.contextTabs} options={tabs} value={selected} onChange={onSelect} tabId={tab => contextTabId(id, tab)} panelId={() => `${id}-body`} />;
}

function ContextBody({ asset, reads, visible, activity, coin, coinPending = false, tab, withThesis, curveLaunch }: FocusContextProps & Readonly<{ tab: ContextTab; withThesis: boolean; curveLaunch: string | null }>) {
  const workspace = useContext(WorkspaceContext);
  if (tab === "portfolio" && workspace) {
    if (!visible) return null;
    const portfolioInBrowser = !workspace.snapshot.data.collapsed && workspace.snapshot.data.selected_view === "Portfolio";
    if (portfolioInBrowser) return <Button variant="secondary" size="sm" onClick={() => workspace.dispatch.setDataCollapsed(true)}>Show portfolio here</Button>;
    return <PortfolioIdentity onTrade={(input, side) => side === "buy" ? workspace.dispatch.openOnBuy(input) : workspace.dispatch.openOnSell(input)} />;
  }
  if (curveLaunch !== null && tab !== "info" && tab !== "portfolio") return <CurveList launchId={curveLaunch} tab={tab} asset={asset} coin={coin} visible={visible} />;
  if (tab === "trades") return activity;
  if (tab === "holders") return <HolderPositions asset={asset} coin={coin} visible={visible} withThesis={withThesis} />;
  if (tab === "posts") return <CoinPosts asset={asset} reads={reads} visible={visible} noun="Theses" emptyTitle="No theses yet" />;
  return <CoinInformation asset={asset} coin={coin} pending={coinPending} />;
}

/** A curve coin's lists come from its launch; Trades is built here, not as the panel's `activity`, so it follows this section's visibility. */
function CurveList({ launchId, tab, asset, coin, visible }: Readonly<{ launchId: string; tab: Exclude<ContextTab, "info" | "portfolio">; asset: FocusContextProps["asset"]; coin: CoinRecord | null; visible: boolean }>) {
  if (tab === "trades") return <CurveTrades launchId={launchId} asset={asset} coin={coin} visible={visible} live />;
  if (tab === "holders") return <CurveHolders launchId={launchId} asset={asset} coin={coin} visible={visible} />;
  return <CurveTheses launchId={launchId} coin={coin} visible={visible} />;
}

/**
 * The holders table (BlastMode.dc.html): who, their position (value over amount),
 * PnL, average entry and thesis from `GET /api/social/home/holders` (#534, the
 * why #589). An account's figures come only when it shares its portfolio;
 * unknown figures stay empty, as does the thesis of a holder without one.
 */
export function HolderPositions({ asset, coin, visible, withThesis }: Readonly<{ asset: FocusContextProps["asset"]; coin: CoinRecord | null; visible: boolean; withThesis: boolean }>) {
  const load = useCallback((signal: AbortSignal) => fetchCoinHolders(asset.coin_type, signal), [asset.coin_type]);
  const holders = useCoinRead<HomeHoldersPage>(visible && asset.network === "mainnet", `holders:${asset.network}:${asset.coin_type}`, load);
  const followingOnly = useContext(FollowingOnlyContext);
  const clearFollowingOnly = useContext(ClearFollowingOnlyContext);
  const store = useViewerStateStore();
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.version ?? noVersion, noVersion);
  const page = holders.value?.coin_type === asset.coin_type ? holders.value : null;
  const callsigns = (page?.holders ?? []).flatMap(holder => holder.actor?.type === "account" ? [holder.actor.callsign] : []).join(",");
  useEffect(() => {
    if (store && callsigns) store.want({ callsigns: callsigns.split(","), followsYou: callsigns.split(",") });
  }, [store, callsigns]);
  if (asset.network !== "mainnet") return <NoRows><PanelEmptyState title="Holders unavailable for this coin" /></NoRows>;
  if (holders.status === "pending" && !page) return <span role="status" aria-label="Loading holders"><SkeletonText>Holder positions, PnL and entries</SkeletonText></span>;
  if (holders.status === "error" && !page) return <NoRows><HoldersFailure unavailable={holders.unavailable} retry={holders.retry} /></NoRows>;
  if (!page) return <NoRows><PanelEmptyState title="Holders unavailable for this coin" /></NoRows>;
  const { rows, empty } = holderRows(page.holders, { follows: followingOnly ? callsign => store?.following({ kind: "account", callsign }) === true : null, withThesis });
  // Following only alone emptied a list that has holders: one press shows them all, as Trades does.
  if (empty !== null) return followingOnly && !withThesis && clearFollowingOnly && page.holders.length > 0
    ? <EmptyState compact role="status" title={empty} action={<Button variant="ghost" size="sm" type="button" onClick={clearFollowingOnly}>Show all holders</Button>} />
    : <PanelEmptyState title={empty} />;
  return <table className={`${styles.holderTable} ${holderStyles.table}`} aria-label={`Largest ${coin?.symbol ?? ""} holders`.replace("  ", " ")}>
    <thead><tr className={styles.holderHead}>
      <th scope="col">Trader</th><th scope="col">Position</th><th scope="col">PnL</th><th scope="col">Avg entry</th><th scope="col" className={holderStyles.thesis}>Thesis</th>
    </tr></thead>
    <tbody>{rows.map(holder => <HolderRow key={actorKey(actorIdentity(holder.actor))} holder={holder} decimals={page.decimals} symbol={coin?.symbol ?? null} />)}</tbody>
  </table>;
}

function HoldersFailure({ unavailable, retry }: Readonly<{ unavailable?: boolean; retry: () => void }>) {
  return unavailable
    ? <PanelEmptyState title="Holders unavailable for this coin" />
    : <EmptyState compact role="alert" title="Holders could not load" action={<Button variant="secondary" size="sm" type="button" onClick={retry}>Retry holders</Button>} />;
}

function HolderRow({ holder, decimals, symbol }: Readonly<{ holder: HomeHolderPosition; decimals: number; symbol: string | null }>) {
  const hidden = useShellPrefs().amountsHidden;
  const identity = actorIdentity(holder.actor);
  const tag = useRelationTag(identity.kind === "account" ? identity.callsign : null, false);
  const pnl = holder.pnl_usd === null ? null : Number(holder.pnl_usd);
  const masked = (value: ReactNode) => hidden ? "••••" : value;
  return <tr className={styles.holderRow}>
    <td className={styles.holderWho}>
      <ActorAvatar identity={identity} size={26} />
      <b title={identity.kind === "account" ? identity.name : identity.short}>{identity.kind === "account" ? identity.name : identity.short}</b>
      {tag && <span className={styles.relation}>{tag}</span>}
    </td>
    <td className={styles.holderPosition}>
      <b>{masked(holder.value_usd === null ? NO_VALUE : holderUsd(holder.value_usd))}</b>
      <span>{masked(<HolderBalance balance={holder.balance} decimals={decimals} symbol={symbol} />)}</span>
    </td>
    <td className={styles.holderPnl} data-direction={direction(pnl)}><b>{masked(signedUsd(pnl))}</b></td>
    <td className={styles.holderEntry}>{masked(holder.average_entry_usd === null ? NO_VALUE : bxPx(Number(holder.average_entry_usd)))}</td>
    <td className={holderStyles.thesis} title={holder.why ?? undefined}>{holder.why}</td>
  </tr>;
}

function HolderBalance({ balance, decimals, symbol }: Readonly<{ balance: string; decimals: number; symbol: string | null }>) {
  const amount = compactFigure(balance, decimals);
  if (amount === null) return null;
  const exact = exactAtoms(balance, decimals);
  const unit = symbol ? ` ${symbol}` : "";
  return <InspectValue label="holder balance" value={`${exact ? groupedExact(exact, decimals) : balance}${unit}`}>{`${amount}${unit}`}</InspectValue>;
}

function direction(value: number | null) {
  if (value === null) return undefined;
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

/** The board's full figures (`$12,380`, `+$3,120`); from a million the compact form keeps the cell's width. */
function holderUsd(raw: string) {
  return Math.abs(Number(raw)) < 1_000_000 ? bxUsd(Number(raw)) : terminalUsd(raw);
}

function signedUsd(value: number | null) {
  if (value === null) return NO_VALUE;
  if (Math.abs(value) >= 1_000_000) return `${value > 0 ? "+" : "−"}${terminalUsd(String(Math.abs(value)))}`;
  return value === 0 ? bxUsd(0) : bxSigned(value);
}

const noSubscribe = () => () => {};
const noVersion = () => 0;

export function useCoinPosition({ asset, coin, actions, visible }: Pick<CoinPanelProps, "asset" | "actions"> & Readonly<{ coin: CoinRecord | null; visible: boolean }>) {
  const readWallet = useCallback(() => actions.trade?.wallet() ?? Promise.resolve(null), [actions.trade]);
  const wallet = useCoinWalletRead(visible && actions.authenticated && asset.network === "mainnet", `${actions.actor_key}:${asset.network}:${asset.coin_type}`, readWallet);
  return { ...positionAmounts(wallet.value, coin, asset.coin_type), status: positionStatus(actions.authenticated, asset.network, wallet), retry: wallet.retry };
}

function positionAmounts(wallet: SocialWallet | null, coin: CoinRecord | null, coinType: string) {
  const balance = walletBalance(wallet, coinType);
  const held = walletCoin(wallet, coinType);
  const decimals = coin?.decimals ?? held?.decimals ?? null;
  const exact = balance === null || decimals === null ? null : exactAtoms(balance.toString(), decimals);
  return { hasHolding: balance === null ? null : balance > BigInt(0), amount: exact ? groupedExact(exact, decimals!) : null, compact: compactFigure(balance?.toString(), decimals), value: held?.value_usd, observed: wallet?.as_of_ms ?? null, symbol: coin?.symbol ?? "asset" };
}

function positionStatus(authenticated: boolean, network: string, wallet: ReturnType<typeof useCoinRead<SocialWallet | null>>) {
  if (!authenticated) return "guest";
  if (network !== "mainnet") return "unsupported";
  if (wallet.status === "pending") return "pending";
  if (wallet.status === "error" || !wallet.value?.coins) return "error";
  return "ready";
}

type Position = ReturnType<typeof useCoinPosition>;

export function CoinTicketSummary({ position, asset, actions, visible, symbol }: Pick<CoinPanelProps, "asset" | "actions"> & Readonly<{ position: Position; visible: boolean; symbol?: string }>) {
  return <>
    {position.status !== "guest" && position.hasHolding !== false && <section className={styles.ticketPosition} aria-label="Your position">
      <dl aria-label="Your holdings" className={`${styles.metrics} ${styles.positionMetrics}`}>
        <CoinPositionMetrics position={position} signIn={actions.signIn} />
        <CoinPnlMetric asset={asset} actions={actions} visible={visible} symbol={symbol} />
      </dl>
    </section>}
  </>;
}

export function CoinPosition({ position, signIn }: Readonly<{ position: Position; signIn: () => void }>) {
  const hidden = useShellPrefs().amountsHidden;
  if (position.status !== "ready") return <p><PositionStatus position={position} signIn={signIn} /></p>;
  return <>
    <dl className={styles.facts}><div><dt>Balance · {position.symbol}</dt><dd><PositionBalance amount={position.amount} compact={position.compact} hidden={hidden} /></dd></div>{(hidden || position.value != null) && <div><dt>Value · USD</dt><dd><PositionValue value={position.value} hidden={hidden} /></dd></div>}</dl>
  </>;
}

export function CoinPositionMetrics({ position, signIn }: Readonly<{ position: Position; signIn: () => void }>) {
  const hidden = useShellPrefs().amountsHidden;
  return <>
    {(position.status === "pending" || (position.status === "ready" && (hidden || position.value != null))) && <div className={styles.positionValue}><dt>Holding value</dt><dd>{position.status === "pending" ? <SkeletonText>$000.00</SkeletonText> : <PositionValue value={position.value} hidden={hidden} />}</dd></div>}
    <div className={styles.positionBalance}><dt className="sr">Your holdings</dt><dd>{position.status === "ready" ? <><PositionBalance amount={position.amount} compact={position.compact} hidden={hidden} /> <span className={styles.holdingSymbol}>{position.symbol}</span></> : <PositionStatus position={position} signIn={signIn} />}</dd></div>
  </>;
}

function PositionStatus({ position, signIn }: Readonly<{ position: Position; signIn: () => void }>) {
  if (position.status === "guest") return <Button variant="ghost" size="sm" className={styles.positionAction} type="button" onClick={signIn}>Sign in</Button>;
  if (position.status === "pending") return <span role="status" aria-label="Loading your holdings"><SkeletonText>Your asset balance</SkeletonText></span>;
  if (position.status === "unsupported") return "Unavailable on this network";
  return <span role="status" className={styles.positionStatus}><span>Unavailable</span><Button variant="ghost" size="sm" className={styles.positionAction} type="button" aria-label="Retry balance" onClick={position.retry}>Retry</Button></span>;
}

function PositionBalance({ amount, compact, hidden }: Readonly<{ amount: string | null; compact: string | null; hidden: boolean }>) {
  if (amount === null) return "Unavailable";
  if (hidden) return "••••";
  return <InspectValue value={amount} label="exact asset balance">{compact ?? amount}</InspectValue>;
}


function PositionValue({ value, hidden }: Readonly<{ value: string | null | undefined; hidden: boolean }>) {
  if (hidden) return "••••";
  if (value == null) return null;
  return <InspectValue value={`$${value}`} label="holding value in USD">{terminalUsd(value)}</InspectValue>;
}

function ContextFilters({ tab, filterable, store, followingOnly, setFollowingOnly, withThesis, setWithThesis }: Readonly<{ tab: ContextTab; filterable: boolean; store: ReturnType<typeof useViewerStateStore>; followingOnly: boolean; setFollowingOnly: (value: boolean) => void; withThesis: boolean; setWithThesis: (value: boolean) => void }>) {
  return <>
      {filterable && <label className={styles.contextFilter} title={store ? undefined : "Sign in to filter by the accounts you follow"}>
        <Checkbox checked={!!store && followingOnly} disabled={!store} onChange={event => setFollowingOnly(event.currentTarget.checked)} />Following only
      </label>}
      {filterable && tab === "holders" && <label className={styles.contextFilter}>
        <Checkbox checked={withThesis} onChange={event => setWithThesis(event.currentTarget.checked)} />With thesis
      </label>}
  </>;
}
