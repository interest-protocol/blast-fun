"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { SUI_COIN_TYPE as SUI_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { normalizeStructTag } from "@mysten/sui/utils";

import { subscribeChartRound, type ChartRoundUpdate } from "../chart/chart-live-round";
import type { BidderCount } from "../coin/CoinExecution";
import { formatDuration } from "../coin/coin-format";
import { StatusText } from "../primitives/StatusText";

import styles from "../trade/trade.module.css";
import { liveBidderCount, sui } from "./opening-round-facts-model";

const TICK_MS = 1_000;
const subscribeClock = (tick: () => void) => {
  const timer = setInterval(tick, TICK_MS);
  return () => clearInterval(timer);
};
const clockSnapshot = () => Math.floor(Date.now() / TICK_MS) * TICK_MS;
const serverClock = () => 0;

/** This device's time, in whole seconds; 0 while rendering on the server. */
function useDeviceClock(): number {
  return useSyncExternalStore(subscribeClock, clockSnapshot, serverClock);
}

/**
 * How an opening round pays out, from `launch::settle_opening_round` and
 * `deliver_opening_round` (contracts 442116a). It names no amount: until
 * settlement nobody knows the Meme a contribution buys.
 */
function PooledDelivery() {
  return (
    <div className={styles.notice} data-pooled-delivery="">
      <p>
        One pooled purchase at settlement. Excess SUI above the graduation target is refunded.
      </p>
      <p>
        Tokens and refunds are allocated pro rata, rounded down. Token amount is unknown until settlement. Bids cannot be withdrawn.
      </p>
    </div>
  );
}

/** Time left until `endsAtMs`, counted on this device from `clockAtMs` (the reference clock read at `readAtMs`). */
function Countdown({ endsAtMs, clockAtMs, readAtMs, reference }: Readonly<{ endsAtMs: number; clockAtMs: number; readAtMs: number; reference: string }>) {
  const device = useDeviceClock();
  if (device === 0) return <>until <DateStamp at={endsAtMs} label="opening-round end time" /></>;
  const left = endsAtMs - (clockAtMs + (device - readAtMs));
  if (left <= 0) return <>ended by {reference} as counted here; reading Sui again</>;
  return <>about {formatDuration(BigInt(Math.ceil(left / 1_000) * 1_000))} by {reference}, counted on this device</>;
}

function FactRow({ term, children }: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div className={styles.factRow}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The pooled facts every viewer sees: start, end, time left, the pot, and the bidder count when known. */
function RoundFacts({
  startsAtMs,
  endsAtMs,
  ended,
  totalLabel,
  timeLeft,
  children,
}: Readonly<{
  startsAtMs: number | null;
  endsAtMs: number | null;
  ended: boolean;
  /** The pot as text. */
  totalLabel: string;
  timeLeft: ReactNode;
  children?: ReactNode;
}>) {
  return (
    <dl className={styles.facts} aria-label="Opening round">
      <FactRow term="Started">{startsAtMs === null ? "Not yet: the launch is not shared" : <DateStamp at={startsAtMs} label="opening-round start time" />}</FactRow>
      <FactRow term="Ends">{endsAtMs === null ? "When the launch is shared, plus the round's length" : <DateStamp at={endsAtMs} label="opening-round end time" />}</FactRow>
      {endsAtMs !== null ? <FactRow term="Time left">{ended ? "None: the round has ended" : timeLeft}</FactRow> : null}
      <FactRow term="Total committed">{totalLabel}</FactRow>
      {children}
    </dl>
  );
}

/** A Quote amount: SUI in whole units, any other Quote in its atoms. */
function quoteAmount(atoms: bigint, quoteType: string): string {
  return normalizeStructTag(quoteType) === SUI_TYPE ? sui(atoms) : `${atoms} atoms of ${quoteType}`;
}

/**
 * The coin page's opening round where this app cannot sign: the pooled facts
 * from the launch object the server read for this request, the bidder count
 * blast-infra indexed, the delivery rules, and why Join is unavailable. Time
 * left is counted on this device; nothing here decides eligibility.
 */
export function OpeningRoundUnavailable({
  round,
  bidders,
  reason,
}: Readonly<{
  round: Readonly<{ startsAtMs: number | null; endsAtMs: number | null; totalQuote: bigint; quoteType: string; readAtMs: number }>;
  bidders: BidderCount | null;
  reason: string;
}>) {
  const ended = round.endsAtMs !== null && round.readAtMs >= round.endsAtMs;
  return (
    <div className={styles.rail}>
      <RoundFacts
        startsAtMs={round.startsAtMs}
        endsAtMs={round.endsAtMs}
        ended={ended}
        totalLabel={quoteAmount(round.totalQuote, round.quoteType)}
        timeLeft={
          round.endsAtMs === null ? null : (
            <Countdown endsAtMs={round.endsAtMs} clockAtMs={round.readAtMs} readAtMs={round.readAtMs} reference="this device's clock" />
          )
        }
      >
        {bidders ? <FactRow term="Bidders"><Bidders bidders={bidders} /></FactRow> : null}
      </RoundFacts>

      <PooledDelivery />
      <p className={styles.notice} data-join-unavailable="">
        <StatusText tone="caution">{reason}</StatusText>
      </p>
    </div>
  );
}

/** The indexed bidder count, replaced by the chart stream's newer pushed rounds; this opens no connection. */
function Bidders({ bidders }: Readonly<{ bidders: BidderCount }>) {
  const [pushed, setPushed] = useState<ChartRoundUpdate | null>(null);
  const poolKey = bidders.live?.poolKey;
  const network = bidders.live?.expected?.network;
  const deployment = bidders.live?.expected?.deployment;
  useEffect(() => {
    if (!poolKey) return;
    return subscribeChartRound(poolKey, network && deployment ? { network, deployment } : null, (round) =>
      setPushed((previous) => previous && (previous.provenance.checkpoint ?? -1) >= (round.provenance.checkpoint ?? -1) ? previous : round));
  }, [poolKey, network, deployment]);
  const { count, stale } = liveBidderCount(bidders, pushed);
  return `${count} (indexed${stale ? "; may be behind" : ""})`;
}
