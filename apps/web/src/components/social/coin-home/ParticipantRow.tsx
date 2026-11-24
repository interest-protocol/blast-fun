"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { coinLogoUrl, useCoinImages } from "#web/components/blast-ui/coin-images.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";

import clsx from "clsx";
import { useId, useState, type ReactNode } from "react";

import { VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import type { HomeEvent, HomeParticipant } from "@blast/core/web/contracts/home.ts";
import { postPath } from "@blast/core/web/contracts/item-routes.ts";
import { bxAgo } from "@blast/core/web/format.ts";

import { explorerAccountUrl, fullDate, walletHue } from "../post/post-format";
import { Avatar, WalletAvatar } from "../post/PostMedia";
import styles from "./CoinHome.module.css";
import { homeAnalytics } from "./home-analytics";
import { CoinWordsWithMarks, KindGlyph } from "./glyphs";
import { actorName, eventSentence, eventUsd, explorerTxUrl, followersText, participantLabel, participantSides, sideLine, type CoinWords } from "./home-model";

/** A moment: the age, with the full date as its title, linked to the explorer when the row has a transaction. */
export function When({ atMs, nowMs, txUrl }: Readonly<{ atMs: number; nowMs: number; txUrl?: string | null }>) {
  const hydrated = useHydrated();
  const title = hydrated ? fullDate(atMs) : `${fullDate(atMs, "UTC")} UTC`;
  const time = <time dateTime={new Date(atMs).toISOString()} title={txUrl ? undefined : title}>{bxAgo(atMs, nowMs)}</time>;
  if (!txUrl) return <span className={styles.when}>{time}</span>;
  return (
    <a className={styles.when} href={txUrl} rel="noopener noreferrer" target="_blank" title={title}>
      {time}
      <span className="sr"> (transaction on the explorer, opens in a new tab)</span>
    </a>
  );
}

export function Face({ participant, size }: Readonly<{ participant: HomeParticipant; size: 26 | 30 }>) {
  const actor = participant.actor;
  if (actor.type === "account") return <Avatar callsign={actor.callsign} size={size} src={actor.avatar_url} />;
  return <span className={styles.wallet} data-size={size}><WalletAvatar hue={walletHue(actor.short)} /></span>;
}

/** The name: a profile link for an account, the explorer for a wallet (never a made-up identity). */
function Name({ participant }: Readonly<{ participant: HomeParticipant }>) {
  const actor = participant.actor;
  if (actor.type === "account") {
    return (
      <>
        <Link className={styles.name} title={hoverExcerpt(actorName(actor))} href={actor.path}>{actorName(actor)}</Link>
        {actor.verified ? <VerifiedBadge className="verified" /> : null}
      </>
    );
  }
  const url = explorerAccountUrl(actor.address);
  return url ? (
    <a className={clsx(styles.name, "mono")} href={url} rel="noopener noreferrer" target="_blank" title="View wallet on explorer">{actor.short}</a>
  ) : (
    <span className={clsx(styles.name, "mono")}>{actor.short}</span>
  );
}

/** The indexer's dollar value, for a trade not quoted in dollars. */
function thenUsd(event: HomeEvent): string | null {
  // A dollar-quoted event already reads in dollars; the indexer's value adds nothing there.
  return event.quote?.quote_symbol?.toUpperCase() === "USDC" ? null : eventUsd(event);
}

/** The coin's words with its mark in place of the symbol (the card is about the coin: its name need not be read on every line). */
type Words = CoinWords & Readonly<{ mark?: ReactNode }>;

type Quote = NonNullable<HomeEvent["quote"]>;

function Said({ text, coin, quotes = [] }: Readonly<{ text: string; coin: Words; quotes?: readonly Quote[] }>) {
  const { failed } = useCoinImages();
  const marks = new Map<string, ReactNode>();
  if (coin.symbol && coin.mark) marks.set(coin.symbol, coin.mark);
  for (const { quote_symbol: symbol, quote_type: type } of quotes) {
    if (!symbol) continue;
    const asset = coreCoin(type);
    if (symbol === coin.symbol || quotes.some((quote) => quote.quote_symbol === symbol && quote.quote_type !== type)) {
      marks.delete(symbol);
    } else if (asset?.symbol === symbol && (symbol === "SUI" || coinLogoUrl(null, asset.logoUrl, failed))) {
      marks.set(symbol, <CoinMark coin={{ key: asset.coinType, iconUrl: asset.logoUrl }} size={16} />);
    }
  }
  return <CoinWordsWithMarks text={text} marks={marks} />;
}

function tradeQuotes(event: HomeEvent): readonly Quote[] {
  return event.quote && (event.kind === "trade_buy" || event.kind === "trade_sell") ? [event.quote] : [];
}

/** One disclosed transaction: the sentence (the direction is its verb, so no glyph), the indexer's value, when (linked to the explorer), its post. */
function EventRow({ event, coin, nowMs }: Readonly<{ event: HomeEvent; coin: Words; nowMs: number }>) {
  const usd = thenUsd(event);
  return (
    <li className={styles.event} data-kind={event.kind}>
      <span className={styles.eventLine}><Said coin={coin} text={eventSentence(event, coin)} quotes={tradeQuotes(event)} /></span>
      {usd ? <span className={clsx("num", styles.eventUsd)}>{usd} then</span> : null}
      <When atMs={event.occurred_at_ms} nowMs={nowMs} txUrl={explorerTxUrl(event.digest)} />
      {event.has_why ? <Link className={styles.eventPost} href={postPath(event.entry_id)}>Post</Link> : null}
    </li>
  );
}

/**
 * A participant in the thread. One event reads as one line (the glyph, the
 * sentence with both legs, its post), with the head's time linked to the
 * transaction. Several read as one summary per direction (a buyer who also
 * sold reads both, never a net), each with its glyph once, then the
 * transactions on demand, worded by their verb.
 */
export function ParticipantRow({ participant, coin, nowMs, presaleId }: Readonly<{ participant: HomeParticipant; coin: Words; nowMs: number; presaleId: string }>) {
  const followers = followersText(participant.followers);
  const events = participant.events ?? [];
  const single = participant.events_total === 1 && events.length === 1 ? events[0]! : null;
  return (
    <li aria-label={participantLabel(participant)} className={styles.participant}>
      <Face participant={participant} size={30} />
      <div className={styles.participantBody}>
        <div className={styles.participantHead}>
          <Name participant={participant} />
          {participant.relation === "followed" ? <span className={styles.ftag}>You follow</span> : null}
          {followers ? <span className={styles.followers}>{followers}</span> : null}
          <When atMs={participant.latest_ms} nowMs={nowMs} txUrl={single ? explorerTxUrl(single.digest) : null} />
        </div>
        {single ? <SingleLine coin={coin} event={single} /> : <Directions coin={coin} participant={participant} />}
        {single === null && events.length > 0 ? <Transactions coin={coin} events={events} nowMs={nowMs} participant={participant} presaleId={presaleId} /> : null}
      </div>
    </li>
  );
}

/** One event as one line: the glyph, the sentence with both legs, the indexer's value where it adds one, its post. */
function SingleLine({ event, coin }: Readonly<{ event: HomeEvent; coin: Words }>) {
  const usd = thenUsd(event);
  return (
    <p className={styles.participantLine}>
      <KindGlyph kind={event.kind} /><Said coin={coin} text={eventSentence(event, coin)} quotes={tradeQuotes(event)} />
      {usd ? <span className={clsx("num", styles.eventUsd)}> · {usd} then</span> : null}
      {event.has_why ? <Link className={styles.eventPost} href={postPath(event.entry_id)}> Post</Link> : null}
    </p>
  );
}

/** One summary per direction, its glyph once. */
function Directions({ participant, coin }: Readonly<{ participant: HomeParticipant; coin: Words }>) {
  return <>{participantSides(participant).map(([kind, side]) => (
    <p className={styles.participantLine} key={kind}>
      <KindGlyph kind={kind} /><Said coin={coin} text={sideLine(kind, side, coin)} quotes={kind === "trade_buy" || kind === "trade_sell" ? side.amounts : undefined} />
    </p>
  ))}</>;
}

/** The transactions behind the summaries, on demand. */
function Transactions({ participant, events, coin, nowMs, presaleId }: Readonly<{ participant: HomeParticipant; events: readonly HomeEvent[]; coin: Words; nowMs: number; presaleId: string }>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <DisclosureButton
        aria-controls={id}
        aria-expanded={open}
        className={styles.eventsToggle}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) homeAnalytics.events(presaleId);
        }}
        type="button"
      >

        {open ? "Hide" : "Show"} {participant.events_total.toLocaleString("en-US")} {participant.events_total === 1 ? "transaction" : "transactions"}
      </DisclosureButton>
      <Collapse id={id} open={open}><ul className={styles.events}>
        {events.map((event) => <EventRow coin={coin} event={event} key={event.activity_id} nowMs={nowMs} />)}
        {participant.events_more ? <li className={styles.eventsMore}>Older transactions in this window are not listed here.</li> : null}
      </ul></Collapse>
    </>
  );
}
