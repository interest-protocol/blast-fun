"use client";

import Link from "next/link";
import type { Chart } from "klinecharts";
import type { BaseUIEvent } from "@base-ui/react/types";
import { memo, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import type { TraderProfile } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { Avatar } from "#web/components/blast-ui/Avatar.tsx";
import { UserIcon } from "#web/components/blast-ui/Icons.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { WalletLabelIcon } from "#web/components/launchpad/activity/WalletLabelIcon.tsx";
import { TraderWallet, useWalletExplorer } from "#web/components/launchpad/activity/TraderWallet.tsx";
import { TRADER_PROFILES_QUERY } from "#web/components/launchpad/activity/trader-profiles.ts";
import { WALLET_LABELS } from "#web/components/launchpad/activity/wallet-labels.ts";
import { useLaunchWallet, useWalletTrades } from "#web/components/launchpad/activity/wallet-trades.tsx";
import { SocialAccountContext } from "#web/components/social/use-social-account.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { readableUsd } from "#web/lib/market-format.ts";
import type { Bar } from "./kline-model.ts";
import { barPeople, layoutBubbles, mousePress, personIdentity, personTrades, profileAt, rememberProfiles, type BarSpan, type Bubble, type Person, type PersonTrade, type SeenProfile } from "./people-bubbles.ts";
import styles from "./PeopleBubbles.module.css";

/** Bubble size in px: a face you can tell apart, still narrow enough for neighbouring bars; a little smaller on phones. */
export const BUBBLE_SIZE = 20;
const bubbleSize = (plotWidth: number) => plotWidth < 560 ? 18 : BUBBLE_SIZE;
const NO_PROFILES: ReadonlyMap<string, SeenProfile> = new Map();
/** A card opens over its bubble, away from the price under it. */
const CARD_POSITION = { side: "top", sideOffset: 6, collisionPadding: 12, className: styles.cardLayer } as const;

/** The box the plot and its bubbles share. The bubbles sit beside the plot, not inside its image role. */
export function BubbleStage({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={styles.stage}>{children}</div>;
}

/**
 * Each trader as an avatar on their trade's bar. Reads only what the page already
 * has: the activity rows, the trade list's trader-profile answers and the viewer's
 * own account. It makes no requests of its own, so the viewer's own trades show
 * when the account is loaded and the trade is among the activity rows.
 */
export function PeopleBubbles({ chart, bars, quoteDecimals, quoteUsd, topInset = 0 }: Readonly<{
  chart: RefObject<Chart | null>;
  bars: readonly Bar[];
  quoteDecimals: number | null;
  quoteUsd: string | null;
  /** Px at the top of the price pane kept clear for the study legends. */
  topInset?: number;
}>) {
  const activity = useWalletTrades();
  const deployer = useLaunchWallet();
  const account = useContext(SocialAccountContext)?.account ?? null;
  const seen = useSeenTraderProfiles();
  const walletKey = account?.wallets.map((wallet) => wallet.address.toLowerCase()).join(",") ?? "";
  const own = useMemo(() => new Set(walletKey ? walletKey.split(",") : []), [walletKey]);
  const people = useMemo(() => barPeople(personTrades(activity, deployer, quoteDecimals, quoteUsd), bars, own), [activity, deployer, quoteDecimals, quoteUsd, bars, own]);
  const callsign = account?.callsign, avatarUrl = account?.avatar_url;
  const ownProfile = useMemo(() => callsign === undefined ? null : { callsign, avatarUrl: avatarUrl ?? null }, [callsign, avatarUrl]);
  const layer = useRef<HTMLDivElement>(null);
  const { bubbles, size } = useBubbleLayout(chart, layer, people, topInset);

  const profile = (person: Person) => person.own ? ownProfile : profileAt(seen, person.address, person.lastMs);
  return <div ref={layer} className={styles.layer}>
    {bubbles.map((bubble) => bubble.kind === "person"
      ? <PersonBubble key={bubble.key} person={bubble.person} x={bubble.x} y={bubble.y} size={size} profile={profile(bubble.person)} />
      : <MoreBubble key={bubble.key} bubble={bubble} size={size} profile={profile} />)}
  </div>;
}

/**
 * Every trader profile the trade list's lookup has answered this visit, per wallet.
 * The list asks only about its newest trades, so profiles build up as trades arrive.
 */
function useSeenTraderProfiles(): ReadonlyMap<string, SeenProfile> {
  const client = useAppQueryClient();
  const [seen, setSeen] = useState(NO_PROFILES);
  useEffect(() => {
    const cache = client.getQueryCache();
    const read = () => setSeen((held) => rememberProfiles(held, cache.findAll({ queryKey: [TRADER_PROFILES_QUERY] }).map((query) => query.state.data)));
    read();
    return cache.subscribe((event) => {
      if (event.type === "updated" && event.query.queryKey[0] === TRADER_PROFILES_QUERY) read();
    });
  }, [client]);
  return seen;
}

/**
 * Bubble positions, recomputed once a frame at most while the chart scrolls, zooms,
 * resizes, gets new bars, or has its price axis dragged (KLineCharts reports no
 * action for that, so a drag over the plot counts).
 */
function useBubbleLayout(chart: RefObject<Chart | null>, layer: RefObject<HTMLElement | null>, people: readonly Person[], topInset: number): Readonly<{ bubbles: readonly Bubble[]; size: number }> {
  const [layout, setLayout] = useState<Readonly<{ bubbles: readonly Bubble[]; size: number }>>({ bubbles: [], size: 20 });
  const latest = useRef({ people, topInset });
  const schedule = useRef<() => void>(() => {});
  useEffect(() => {
    let frame = 0;
    let current: Chart | null = null;
    const place = () => {
      frame = 0;
      const size = current?.getSize("candle_pane", "main");
      if (!current || !size) return;
      const target = current;
      const bubble = bubbleSize(size.width);
      setLayout({ size: bubble, bubbles: layoutBubbles(latest.current.people, (person) => barSpans(target, [{ timestamp: person.bar, high: person.high, low: person.low }])[0] ?? null, size.width, size.height, bubble, latest.current.topInset, visibleSpans(target)) });
    };
    const request = () => { if (!frame) frame = requestAnimationFrame(place); };
    // A drag that starts on the chart keeps following the pointer outside it, as the chart does.
    const move = () => request();
    const release = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", release);
      document.removeEventListener("pointercancel", release);
      request();
    };
    const press = () => {
      document.addEventListener("pointermove", move, { passive: true });
      document.addEventListener("pointerup", release);
      document.addEventListener("pointercancel", release);
    };
    schedule.current = request;
    const actions = ["onVisibleRangeChange", "onZoom", "onScroll", "onPaneDrag"] as const;
    const resize = new ResizeObserver(request);
    const stage = layer.current?.parentElement;
    stage?.addEventListener("pointerdown", press);
    // A double-click on the price axis resets its scale without any chart action.
    stage?.addEventListener("dblclick", request);
    // The chart is created in the parent's effect, which runs after this one; give up after about ten seconds.
    let tries = 600;
    let attach = requestAnimationFrame(function find() {
      current = chart.current;
      if (!current) { if (--tries > 0) attach = requestAnimationFrame(find); return; }
      for (const action of actions) current.subscribeAction(action, request);
      // The candle pane shrinks when an indicator pane opens, without the plot resizing.
      const pane = current.getDom("candle_pane", "main");
      if (pane) resize.observe(pane);
      request();
    });
    if (layer.current) resize.observe(layer.current);
    return () => {
      cancelAnimationFrame(attach);
      cancelAnimationFrame(frame);
      resize.disconnect();
      stage?.removeEventListener("pointerdown", press);
      stage?.removeEventListener("dblclick", request);
      release();
      for (const action of actions) current?.unsubscribeAction(action, request);
      schedule.current = () => {};
    };
  }, [chart, layer]);
  useEffect(() => {
    latest.current = { people, topInset };
    // Wait a frame so the chart has drawn the new bars and axis first.
    schedule.current();
  }, [people, topInset]);
  return layout;
}

type PricedBar = Readonly<{ timestamp: number; high: number; low: number }>;

/** Each bar's x and the y of its high and low, in px over the price pane; null where the chart can't place it. */
function barSpans(chart: Chart, bars: readonly PricedBar[]): (BarSpan | null)[] {
  const points = chart.convertToPixel(bars.flatMap(({ timestamp, high, low }) => [{ timestamp, value: high }, { timestamp, value: low }]), { paneId: "candle_pane" });
  return bars.map((_, index) => {
    const top = Array.isArray(points) ? points[index * 2] : undefined, bottom = Array.isArray(points) ? points[index * 2 + 1] : undefined;
    return top?.x === undefined || top.y === undefined || bottom?.y === undefined ? null : { x: top.x, top: top.y, bottom: bottom.y };
  });
}

/** The bars on screen, so a bubble also clears its neighbours' prices, not only its own bar's. */
function visibleSpans(chart: Chart): BarSpan[] {
  const { realFrom, realTo } = chart.getVisibleRange();
  return barSpans(chart, chart.getDataList().slice(Math.max(0, realFrom), Math.max(0, realTo))).filter((span) => span !== null);
}

const PersonBubble = memo(function PersonBubble({ person, x, y, size, profile }: Readonly<{ person: Person; x: number; y: number; size: number; profile: TraderProfile | null }>) {
  const who = personIdentity(person.address, profile);
  const explorer = useWalletExplorer(who.anonymous ? person.address : null);
  const badge = person.labels[0];
  const count = person.buys + person.sells;
  const page = useBubblePage(who.anonymous ? explorer?.url : profilePagePath(who.callsign), who.anonymous);
  return <Popover.Root>
    <Popover.Trigger
      openOnHover
      delay={80}
      nativeButton={false}
      {...page}
      className={styles.bubble}
      data-side={person.side}
      data-own={person.own || undefined}
      data-anonymous={who.anonymous || undefined}
      aria-label={count > 1 ? `${who.name}, ${tradeCount(count)}` : who.name}
      title={explorer?.label}
      {...dyn({ left: x - size / 2, top: y - size / 2, width: size, height: size })}
    >
      {who.anonymous
        ? <span className={styles.anonymous}><UserIcon /></span>
        : <Avatar accountId={who.callsign} avatarUrl={who.avatarUrl} size={size} />}
      {count > 1 && <span className={styles.count} aria-hidden="true">{count > 99 ? "99+" : count}</span>}
      {badge && <span className={styles.badge}><WalletLabelIcon label={badge} /></span>}
    </Popover.Trigger>
    <PopoverSurface positioner={CARD_POSITION} popup={{ className: styles.card }}>
      <PersonCard person={person} who={who} />
    </PopoverSurface>
  </Popover.Root>;
});

/** The card a bubble opens: who the trader is, their wallet, what they traded and their wallet labels. */
function PersonCard({ person, who }: Readonly<{ person: Person; who: ReturnType<typeof personIdentity> }>) {
  return <>
    <Popover.Title className={who.anonymous && !person.own ? "sr-only" : styles.cardName}>
      {who.anonymous ? <span className={person.own ? "sr-only" : undefined}>{who.name}</span> : <Link href={profilePagePath(who.callsign)}>{who.name}</Link>}
      {person.own && <span className={styles.you}>You</span>}
    </Popover.Title>
    <TraderWallet address={person.address} />
    <dl className={styles.cardFigures}>
      {person.buys > 0 && <div><dt>{person.buys === 1 ? "Bought" : `${person.buys} buys`}</dt><dd data-side="buy">{usd(person.bought)}</dd></div>}
      {person.sells > 0 && <div><dt>{person.sells === 1 ? "Sold" : `${person.sells} sells`}</dt><dd data-side="sell">{usd(person.sold)}</dd></div>}
    </dl>
    {person.trades.length > 1 && <TradeList trades={person.trades} />}
    {person.labels.length > 0 && <p className={styles.cardLabels}>
      {person.labels.map((label) => <span key={label}><WalletLabelIcon label={label} /> {WALLET_LABELS[label].name}</span>)}
    </p>}
  </>;
}

/**
 * A bubble's link to who the trader is: the profile page, or the wallet on the explorer in a new tab.
 * A mouse click follows it; a tap, a key or a screen reader opens the card, which holds the same links.
 */
function useBubblePage(href: string | undefined, external: boolean) {
  const mouse = useRef(false);
  if (!href) return { render: <span /> };
  return {
    "data-page": "",
    render: external
      ? (props: ComponentProps<"a">) => <a {...props} href={href} rel="noopener noreferrer" target="_blank" />
      : (props: ComponentProps<"a">) => <Link {...props} href={href} prefetch={false} />,
    onPointerDown: (event: PointerEvent) => { mouse.current = mousePress(event); },
    onClick: (event: BaseUIEvent<MouseEvent>) => {
      const followLink = mouse.current && event.detail > 0;
      mouse.current = false;
      if (followLink) event.preventBaseUIHandler();
      else event.preventDefault();
    },
  };
}

/** Each of a wallet's trades on the bar, newest first: side, time and size. Scrolls when long. */
function TradeList({ trades }: Readonly<{ trades: readonly PersonTrade[] }>) {
  return <ol className={styles.cardTrades} aria-label="Trades" tabIndex={0}>
    {trades.map((trade, index) => <li key={`${trade.timestampMs}:${index}`}>
      <span data-side={trade.side}>{trade.side === "buy" ? "Buy" : "Sell"}</span>
      <time dateTime={new Date(trade.timestampMs).toISOString()}>{tradeTime(trade.timestampMs)}</time>
      <span>{usd(trade.usd)}</span>
    </li>)}
  </ol>;
}

/** The people one column has no room for, as a "+N" that lists them on hover or tap. */
function MoreBubble({ bubble: { people, x, y }, size, profile }: Readonly<{ bubble: Extract<Bubble, { kind: "more" }>; size: number; profile: (person: Person) => TraderProfile | null }>) {
  const text = `${people.length} more ${people.length === 1 ? "trader" : "traders"}`;
  return <Popover.Root>
    <Popover.Trigger
      openOnHover
      delay={80}
      className={styles.more}
      aria-label={text}
      {...dyn({ left: x - size / 2, top: y - size / 2, height: size, minWidth: size })}
    >+{people.length > 99 ? "99" : people.length}</Popover.Trigger>
    <PopoverSurface positioner={CARD_POSITION} popup={{ className: styles.card }}>
      <Popover.Title className={styles.cardName}>{text}</Popover.Title>
      <ul className={styles.cardPeople} tabIndex={0} aria-label="Traders">
        {people.map((person) => {
          const count = person.buys + person.sells;
          const spent = person.side === "buy" ? person.bought : person.sold;
          return <li key={`${person.bar}:${person.address}`}>
            <span>{personIdentity(person.address, profile(person)).name}</span>
            <span data-side={person.side}>{person.side === "buy" ? "Bought" : "Sold"}{count > 1 ? ` · ${tradeCount(count)}` : ""}</span>
            <span>{usd(spent)}</span>
          </li>;
        })}
      </ul>
    </PopoverSurface>
  </Popover.Root>;
}

const tradeCount = (count: number) => `${count} trades`;
const TRADE_TIME = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const TRADE_DAY_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** A trade's time in the viewer's zone, as the chart's axis reads; the day too when it isn't today. */
const tradeTime = (ms: number) => (new Date(ms).toDateString() === new Date().toDateString() ? TRADE_TIME : TRADE_DAY_TIME).format(ms);
const usd = (value: number | null) => value === null ? "—" : readableUsd(value.toFixed(6));
