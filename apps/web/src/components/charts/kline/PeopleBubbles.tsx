"use client";

import Link from "next/link";
import type { Chart } from "klinecharts";
import { memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
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
import { barPeople, layoutBubbles, mousePress, personIdentity, personTrades, profileAt, rememberProfiles, type Bubble, type Person, type SeenProfile } from "./people-bubbles.ts";
import styles from "./PeopleBubbles.module.css";

/** Bubble size in px; phones get smaller ones so the price stays readable. */
const bubbleSize = (plotWidth: number) => plotWidth < 560 ? 18 : 24;
const NO_PROFILES: ReadonlyMap<string, SeenProfile> = new Map();

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
export function PeopleBubbles({ chart, bars, quoteDecimals, quoteUsd }: Readonly<{
  chart: RefObject<Chart | null>;
  bars: readonly Bar[];
  quoteDecimals: number | null;
  quoteUsd: string | null;
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
  const { bubbles, size } = useBubbleLayout(chart, layer, people);

  return <div ref={layer} className={styles.layer}>
    {bubbles.map((bubble) => bubble.kind === "person"
      ? <PersonBubble key={bubble.key} person={bubble.person} x={bubble.x} y={bubble.y} size={size} profile={bubble.person.own ? ownProfile : profileAt(seen, bubble.person.address, bubble.person.lastMs)} />
      : <MoreBubble key={bubble.key} bubble={bubble} size={size} />)}
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
function useBubbleLayout(chart: RefObject<Chart | null>, layer: RefObject<HTMLElement | null>, people: readonly Person[]): Readonly<{ bubbles: readonly Bubble[]; size: number }> {
  const [layout, setLayout] = useState<Readonly<{ bubbles: readonly Bubble[]; size: number }>>({ bubbles: [], size: 24 });
  const latest = useRef(people);
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
      setLayout({ size: bubble, bubbles: layoutBubbles(latest.current, (person) => {
        const point = target.convertToPixel({ timestamp: person.bar, value: person.value }, { paneId: "candle_pane" });
        return Array.isArray(point) || point.x === undefined || point.y === undefined ? null : { x: point.x, y: point.y };
      }, size.width, size.height, bubble) });
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
    latest.current = people;
    // Wait a frame so the chart has drawn the new bars and axis first.
    schedule.current();
  }, [people]);
  return layout;
}

const PersonBubble = memo(function PersonBubble({ person, x, y, size, profile }: Readonly<{ person: Person; x: number; y: number; size: number; profile: TraderProfile | null }>) {
  const who = personIdentity(person.address, profile);
  const explorer = useWalletExplorer(who.anonymous ? person.address : null);
  const badge = person.labels[0];
  // A mouse click opens who the trader is; a tap, a key or a screen reader opens the card, which holds the same links.
  const href = who.anonymous ? explorer?.url : profilePagePath(who.callsign);
  const mouse = useRef(false);
  let page = <span />;
  if (href && !who.anonymous) page = <Link href={href} prefetch={false} />;
  else if (href) page = <a href={href} rel="noopener noreferrer" target="_blank" />;
  return <Popover.Root>
    <Popover.Trigger
      openOnHover
      delay={80}
      nativeButton={false}
      render={page}
      onPointerDown={(event) => { mouse.current = mousePress(event); }}
      onClick={(event) => {
        if (!href) return;
        const followLink = mouse.current && event.detail > 0;
        mouse.current = false;
        if (followLink) event.preventBaseUIHandler();
        else event.preventDefault();
      }}
      className={styles.bubble}
      data-side={person.side}
      data-own={person.own || undefined}
      data-anonymous={who.anonymous || undefined}
      data-page={href ? "" : undefined}
      aria-label={who.name}
      title={explorer?.label}
      {...dyn({ left: x - size / 2, top: y - size / 2, width: size, height: size })}
    >
      {who.anonymous
        ? <span className={styles.anonymous}><UserIcon /></span>
        : <Avatar accountId={who.callsign} avatarUrl={who.avatarUrl} size={size} />}
      {badge && <span className={styles.badge}><WalletLabelIcon label={badge} /></span>}
    </Popover.Trigger>
    <PopoverSurface positioner={{ side: person.side === "buy" ? "bottom" : "top", sideOffset: 6, collisionPadding: 12, className: styles.cardLayer }} popup={{ className: styles.card }}>
      <Popover.Title className={who.anonymous && !person.own ? "sr-only" : styles.cardName}>
        {who.anonymous ? <span className={person.own ? "sr-only" : undefined}>{who.name}</span> : <Link href={profilePagePath(who.callsign)}>{who.name}</Link>}
        {person.own && <span className={styles.you}>You</span>}
      </Popover.Title>
      <TraderWallet address={person.address} />
      <dl className={styles.cardFigures}>
        {person.buys > 0 && <div><dt>Bought</dt><dd data-side="buy">{usd(person.bought)}</dd></div>}
        {person.sells > 0 && <div><dt>Sold</dt><dd data-side="sell">{usd(person.sold)}</dd></div>}
      </dl>
      {person.labels.length > 0 && <p className={styles.cardLabels}>
        {person.labels.map((label) => <span key={label}><WalletLabelIcon label={label} /> {WALLET_LABELS[label].name}</span>)}
      </p>}
    </PopoverSurface>
  </Popover.Root>;
});

function MoreBubble({ bubble: { people, x, y }, size }: Readonly<{ bubble: Extract<Bubble, { kind: "more" }>; size: number }>) {
  const buyers = people.filter((person) => person.side === "buy").length;
  let who = "traders";
  if (buyers === people.length) who = "buyers";
  else if (buyers === 0) who = "sellers";
  const text = `${people.length} more ${who}. Zoom in to see them.`;
  return <span
    className={styles.more}
    role="note"
    aria-label={text}
    title={text}
    {...dyn({ left: x - size / 2, top: y - size / 2, height: size, minWidth: size })}
  >+{people.length > 99 ? "99" : people.length}</span>;
}

const usd = (value: number | null) => value === null ? "—" : readableUsd(value.toFixed(6));
