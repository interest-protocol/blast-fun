"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { isActivityTrade, type ActivityRow, type WindowName } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import { POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import type { Exact } from "@blast/core/web/exact-amount.ts";

import { atCheckpoint, browserMarketDependencies } from "../blast-infra-browser";
import { tabMarketStream } from "../market-stream-hub";
import { useMarketPoll } from "../use-market-poll";
import { readActivityPage, readFlow } from "./activity-client";
import { browserAnchorPorts, keepAnchorInView } from "./anchor-keeper";
import { createActivityFeed, linkTarget, listStart, shownActivity } from "./activity-feed";
import { followLiveTrades } from "./activity-live";
import type { PageOutcome } from "./activity-model";
import { usePublishWalletTrades } from "./wallet-trades";
import { dustQuoteUsd, isTradeUnderDollar, tradeFloor } from "./small-trades";
import { useCoinPriceCurrency } from "../chart/CoinPriceCurrency";
import { createTradeTape } from "./trade-tape";
import { ActivityView, type ActivityUnits, type TransactionExplorer } from "./ActivityView";
import { useLiveScreen } from "../coin/LiveScreen";

const NO_ROWS: readonly ActivityRow[] = [];
const skipSubscription = () => () => {};

/**
 * Which launch's activity the browser reads (through this app's
 * `/api/launchpad/market` routes, never blast-infra itself), for the
 * deployment this page serves, and how the page shows it. Nothing here is
 * secret; the server hands it to the page.
 */
export type ActivitySource = Readonly<{
  launchId: string;
  /** The deployment the page serves; answers about another are Unavailable. Null checks nothing. */
  expected: ExpectedDeployment | null;
  units: ActivityUnits;
  explorer: TransactionExplorer | null;
  /** A durable link's record position (`?activity=`), checked by the server; null for the newest. */
  anchor: string | null;
  /**
   * The pools whose trade frames the list shows before its next read: the
   * chart's own pools and deployment, so both share the tab's one stream.
   * Absent, the list only polls.
   */
  livePools?: readonly string[];
}>;

type CoinActivityProps = Readonly<{
  source: ActivitySource;
  compact?: boolean;
  initialActivity?: PageOutcome<ActivityRow>;
}>;

/**
 * The coin page's Activity destination in the browser. It reads the
 * classified launch activity — the curve's history and, after migration, the
 * venue pool's swaps, which blast-infra merges into it — and the curve's
 * windowed flow through this app's `/api/launchpad/market` routes, which
 * relay blast-infra's `/v1` answers (`activity-feed.ts`), re-reads them every
 * 15 s while visible (`useMarketPoll`), and pages back on request. A durable
 * link starts the list at its record and scrolls it into view once. With
 * `livePools`, the newest page also follows the tab's market stream
 * (`activity-live.ts`): each trade frame shows at once as a provisional row,
 * a gap or reconnect asks for one pinned read, and the poll slows to 30 s
 * while the stream is live.
 */
export function CoinActivity(props: CoinActivityProps) {
  const { source } = props;
  const start = listStart(source.launchId, source.anchor);
  const key = JSON.stringify([source.launchId, source.expected?.network, source.expected?.deployment, start]);
  return <CoinActivityFeed key={key} {...props} start={start} />;
}

function CoinActivityFeed({ source, compact, initialActivity, start }: CoinActivityProps & Readonly<{ start: string | null }>) {
  const [flowWindow, setFlowWindow] = useState<WindowName>("24h");
  const { launchId, anchor } = source;
  const network = source.expected?.network ?? null;
  const deployment = source.expected?.deployment ?? null;
  const [feed] = useState(() => {
    const dependencies = browserMarketDependencies(network && deployment ? { network, deployment } : null);
    return createActivityFeed({
      start,
      initialActivity,
      reads: {
        activity: (cursor, at) => readActivityPage(launchId, cursor, atCheckpoint(dependencies, at)),
        flow: (at) => readFlow(launchId, atCheckpoint(dependencies, at)),
      },
    });
  });
  const tape = useMemo(() => createTradeTape(feed), [feed]);
  const state = useSyncExternalStore(feed.subscribe, feed.state, feed.state);
  const activity = useMemo(() => shownActivity(state), [state]);
  // An activity permalink starts partway through the tape and cannot name its latest trade.
  // The Last-trade pill skips dust, as the trades list does.
  const quoteUsd = dustQuoteUsd(source.units.quoteType, useCoinPriceCurrency(), source.units.quoteUsd);
  const isUnder = (row: ActivityRow, floor?: Exact) => isTradeUnderDollar({ usd: row.volumeUsd, quote: row.amounts.quote, decimals: source.units.quoteDecimals, quoteUsd }, floor);
  const shownTrade = (row: ActivityRow) => isActivityTrade(row) && !isUnder(row);
  const lastTrade = start === null
    ? activity.newer?.rows.find(shownTrade) ?? activity.view?.rows.find(shownTrade)
    : null;
  usePublishWalletTrades(activity.view?.rows ?? NO_ROWS, lastTrade ?? null);
  const scrolled = useRef(false);
  const showTape = Boolean(compact && !anchor);
  const recent = useSyncExternalStore(showTape ? tape.subscribe : skipSubscription, tape.snapshot, tape.serverSnapshot);

  // "Hide trades under $1": while it is on, a streamed dust trade takes no row and asks no read, so a
  // bot's burst cannot push the real trades off the list. Turning it off reads through the newest one skipped.
  // A tiny trade never takes a row, the switch on or off.
  const [hideSmallTrades, setHideSmallTrades] = useState(true);
  const following = useRef<ReturnType<typeof followLiveTrades> | null>(null);
  const hidesLive = useEffectEvent((row: ActivityRow) => showTape && isUnder(row, tradeFloor(hideSmallTrades)));
  const smallTradeFilter = useMemo(() => [hideSmallTrades, (hide: boolean) => {
    setHideSmallTrades(hide);
    if (!hide) following.current?.showHidden();
  }] as const, [hideSmallTrades]);

  // Only the newest page follows the stream; a link's page stays on its reads.
  const pools = start === null ? [...new Set(source.livePools ?? [])].filter((pool) => POOL_KEY.test(pool)).slice(0, 2) : [];
  const poolsKey = pools.join(",");
  const [stream, setStream] = useState({ key: "", live: false });
  const liveScreen = useLiveScreen();
  const live = stream.key === poolsKey && stream.live;
  useEffect(() => {
    const hub = poolsKey ? tabMarketStream() : null;
    if (!hub) return;
    const follow = followLiveTrades({
      hub,
      launchId,
      pools: poolsKey.split(","),
      expected: network && deployment ? { network, deployment } : null,
      feed,
      hides: (row) => hidesLive(row),
      onState: (state) => setStream({ key: poolsKey, live: state === "live" }),
      schedule: (run, ms) => {
        const timer = window.setTimeout(run, ms);
        return () => window.clearTimeout(timer);
      },
      now: Date.now,
      random: Math.random,
    });
    following.current = follow;
    return () => {
      following.current = null;
      follow();
    };
  }, [feed, launchId, network, deployment, poolsKey]);
  useMarketPoll({
    live,
    stopWhileLive: liveScreen,
    onInitialRefresh: () => void feed.initialize(),
    onRefresh: (at) => void feed.refresh(false, at),
  });

  // A durable link's record is usually below the fold: bring it (or the note
  // saying it is not there) into view when the lists first answer, and keep
  // it there while sections above it still load (on mobile the Theses list
  // renders above Activity), until the reader scrolls or the page settles.
  const stopKeeping = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (scrolled.current) return;
    const target = linkTarget(launchId, anchor, state);
    if (target === null) return;
    scrolled.current = true;
    stopKeeping.current = keepAnchorInView(browserAnchorPorts(target));
  }, [launchId, anchor, state, feed]);
  useEffect(() => () => stopKeeping.current?.(), []);

  return (
    <ActivityView
      compact={compact}
      confirmedActivity={showTape ? state.activity : undefined}
      launchId={launchId}
      activity={activity}
      tape={showTape ? { recent, hold: tape.hold } : undefined}
      flow={state.flow}
      window={flowWindow}
      units={source.units}
      explorer={source.explorer}
      anchor={anchor}
      pending={state.pending}
      onRefresh={() => void feed.refresh(true)}
      onMoreActivity={() => void feed.more()}
      onShowNewerActivity={() => feed.showNewer()}
      onWindow={setFlowWindow}
      smallTradeFilter={smallTradeFilter}
    />
  );
}
