import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { useContext, useEffect, useRef, useState } from "react";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { postPath } from "@blast/core/web/contracts/item-routes.ts";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";
import { explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { ActorCell, Facepile } from "../ActorCell";
import { actorIdentity, actorKey } from "../actor-identity";
import type { CoinRecord } from "./coin-reads";
import { ChartTradesContext } from "./chart-trades-context";
import { annotationId, annotationTime, chartTradeY, groupChartTrades, type ChartAnnotation, type ChartTrade } from "./chart-trades";
import type { PlacedObservation } from "./chart-visual";
import styles from "./ChartTrades.module.css";

/** Timing follows the observed curve; the feed does not carry execution prices. */
export function ChartTradeMarkers({ start, end, segments, projectTime }: Readonly<{ start: number; end: number; segments: readonly (readonly PlacedObservation[])[]; projectTime?: (at: number) => number | null }>) {
  const { trades, coin, enabled } = useContext(ChartTradesContext);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);
  if (!enabled) return null;
  const groups = groupChartTrades(trades, start, end, width, 64, projectTime);
  return <div className={styles.overlay} ref={ref} role="group" aria-label="Trades on price chart">
    {groups.map(group => <TradeMarker key={group.index} trades={group.trades} coin={coin} left={group.left} top={chartTradeY(segments, group.left)} />)}
  </div>;
}

/** Coverage and recovery remain outside the plot and its marker targets. */
export function ChartTradeStatus({ start, end }: Readonly<{ start: number; end: number }>) {
  const { trades, enabled, partial, ready, notice, window } = useContext(ChartTradesContext);
  if (!enabled) return null;
  const matches = trades.some(trade => annotationTime(trade) >= start && annotationTime(trade) <= end);
  return <div className={styles.coverage}>
    {window && <span className={styles.legend}><span>Trades · {window}{partial ? " · partial history" : ""}</span> · chart price</span>}
    {!matches && ready && <span className={styles.noMatches}>No matching trades in this view.</span>}
    <div className={styles.status}>{notice}</div>
  </div>;
}

function describeTrades(trades: readonly ChartAnnotation[]) {
  const buys = trades.filter(trade => "event" in trade && trade.event.kind === "trade_buy").length;
  const sells = trades.filter(trade => "event" in trade && trade.event.kind === "trade_sell").length;
  const calls = trades.filter(trade => "post" in trade && trade.post.call).length;
  const theses = trades.filter(trade => "post" in trade && !trade.post.call).length;
  const hasThesis = theses > 0 || trades.some(trade => "event" in trade && !!trade.thesis?.why);
  const hasCall = calls > 0 || trades.some(trade => "event" in trade && trade.thesis?.call);
  const identities = [...new Map(trades.map(trade => { const identity = actorIdentity(trade.actor); return [actorKey(identity), identity] as const; })).values()];
  const names = identities.map(identity => identity.kind === "account" ? identity.name : identity.short).join(", ");
  const label = `${buys} ${buys === 1 ? "buy" : "buys"}, ${sells} ${sells === 1 ? "sell" : "sells"}${calls ? `, ${calls} calls` : ""}${theses ? `, ${theses} theses` : ""}. ${names}. ${hasCall ? "Call available. " : ""}${hasThesis ? "Thesis available. " : ""}`;
  return { buys, sells, calls, theses, hasCall, hasThesis, identities, label };
}

function TradeMarker({ trades, coin, left, top }: Readonly<{ trades: readonly ChartAnnotation[]; coin: CoinRecord | null; left: number; top: number | null }>) {
  const { buys, sells, calls, theses, hasCall, hasThesis, identities, label: activityLabel } = describeTrades(trades);
  const label = `${activityLabel}${top === null ? "Time only; no chart price observation. " : ""}Inspect chart activity`;
  return <div className={styles.markerPosition} data-time-only={top === null || undefined} {...dyn({ left: `${left}%`, top: `clamp(22px, ${top ?? 100}%, calc(100% - 22px))` })}>
    <Popover.Root>
      <Popover.Trigger render={<Button variant="secondary" size="sm" />} className={styles.marker} data-chart-trade-marker="" aria-label={label}>
        <Facepile identities={identities} size={22} max={2} />
        {trades.length > 1 && <span className={styles.markerCount} aria-hidden="true">{trades.length > 9 ? "9+" : trades.length}</span>}
        <span className={styles.directionBadge} aria-hidden="true">
          {buys > 0 && <span className={styles.buy}>↑</span>}{sells > 0 && <span className={styles.sell}>↓</span>}{(hasCall || hasThesis) && <span className={styles.postBadge}>{hasCall ? "C" : "T"}</span>}
        </span>
      </Popover.Trigger>
      <PopoverSurface
        positioner={{ side: "top", sideOffset: 8, collisionPadding: 12, className: styles.layer }}
        popup={{ className: styles.popup, "aria-label": "Chart trade details" }}
      >
          <Popover.Title className={styles.title}>{trades.length} {calls || theses ? "chart events" : trades.length === 1 ? "trade" : "trades"}</Popover.Title>
          <p className={styles.note}>{top === null ? "Time only · price unavailable" : "Execution price unavailable"}</p>
          <ul className={styles.trades}>{trades.map(trade => "event" in trade ? <TradeDetail key={annotationId(trade)} trade={trade} coin={coin} /> : <PostDetail key={annotationId(trade)} post={trade.post} />)}</ul>
          <Popover.Close render={<Button variant="ghost" size="sm" />} className="btn btn-quiet btn-sm">Close</Popover.Close>
        </PopoverSurface>
    </Popover.Root>
  </div>;
}

function TradeDetail({ trade, coin }: Readonly<{ trade: ChartTrade; coin: CoinRecord | null }>) {
  const hidden = useShellPrefs().amountsHidden;
  const { explorer } = useDevicePrefs();
  const { event, actor, groups, pnlRank } = trade;
  const href = event.digest ? explorerTransactionUrl(explorer, event.digest) : null;
  const amount = chartTradeAmount(trade, coin);
  const buy = event.kind === "trade_buy";
  return <li>
    <ActorCell identity={actorIdentity(actor)} showFollowing={false} />
    <p className={styles.tags}>{groups.map(group => group === "kol" ? "KOL" : group === "top" ? `Top trader #${pnlRank} · 24h PnL` : group === "mine" ? "Your trade" : group === "big" ? "Big trade" : "Following").join(" · ")}</p>
    <p className={styles.tradeAmount}><strong className={buy ? styles.buy : styles.sell}>{buy ? "Buy" : "Sell"}</strong> {hidden ? "••••" : <InspectValue label="chart trade amount" value={amount.exact}>{amount.display}</InspectValue>}</p>
    <DateStamp at={event.occurred_at_ms} label="trade time" />
    {trade.thesis && <AuthoredPost post={trade.thesis} />}
    {!trade.thesis && event.has_why && <IntentLink className={styles.postLink} href={postPath(event.entry_id)}>Read thesis</IntentLink>}
    {href && <TransactionLink href={href} />}
  </li>;
}

function AuthoredPost({ post }: Readonly<{ post: FeedItem }>) {
  return <div className={styles.authoredPost}>
    <span className={styles.postType}>{post.call ? "Call" : "Thesis"}</span>
    {post.why && <p className={styles.thesis}>{post.why.text}</p>}
    <IntentLink className={styles.postLink} href={postPath(post.entry_id)}>View post</IntentLink>
  </div>;
}

function PostDetail({ post }: Readonly<{ post: FeedItem }>) {
  return <li>{post.actor && <ActorCell identity={actorIdentity(post.actor)} showFollowing={false} />}
    <AuthoredPost post={post} />
    <span>Post · <DateStamp at={post.occurred_at_ms} label="post time" /></span>
  </li>;
}

function chartTradeAmount({ event }: ChartTrade, coin: CoinRecord | null) {
  const quote = event.quote;
  const parsed = quote?.quote_decimals == null ? null : exactAtoms(quote.atoms, quote.quote_decimals);
  const amount = parsed && quote?.quote_symbol ? `${groupedExact(parsed, parsed.scale)} ${quote.quote_symbol}` : "Amount unavailable";
  const tokens = coin?.decimals == null ? null : exactAtoms(event.tokens, coin.decimals);
  const exact = `${amount}${quote?.usd == null ? "" : ` · $${quote.usd}`}${tokens && coin ? ` · ${groupedExact(tokens, tokens.scale)} ${coin.symbol}` : ""}`;
  return { exact, display: quote?.usd == null ? amount : `$${quote.usd}` };
}
