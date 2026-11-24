import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import type { ReactNode } from "react";

import type { RecordedRoute } from "@blast/core/modules/launchpad-coin/fresh-types.ts";
import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";

import styles from "./Coin.module.css";
import { describeReason, venueMarketCatchingUp } from "./coin-view";
import { ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { venueName } from "@blast/core/lib/format.ts";

/** What a trade vertical receives: the pool it may trade, already eligible on the launch object. */
export type TradeSlotContext = Readonly<{ launchId: string; coinType: string; poolKey: string; venue: string }>;

/**
 * What the opening-round vertical receives: the round as the fresh launch
 * object showed it for this request (its start, end, and the pot of
 * undelivered bids), and blast-infra's bidder count when the curve section has
 * it, which the chart stream's pushed rounds keep current. Joining still reads
 * the launch and Sui's clock again before signing.
 */
export type BidSlotContext = Readonly<{
  launchId: string;
  coinType: string;
  round: Readonly<{
    /** `public_start_ms`; null before the launch is shared. */
    startsAtMs: number | null;
    /** `public_start_ms + opening_round_ms`; null before the launch is shared. */
    endsAtMs: number | null;
    /** `opening_round_bids`: the Quote every bidder committed and has not been delivered. */
    totalQuote: bigint;
    quoteType: string;
    /** When the server read the launch object. */
    readAtMs: number;
  }>;
  /**
   * blast-infra's (T-025) bidder count; `stale` when its section is; null when it has none.
   * `live` names the curve pool, deployment and section checkpoint a newer pushed round replaces it after.
   */
  bidders: BidderCount | null;
}>;

export type BidderCount = Readonly<{
  count: number;
  stale: boolean;
  live: Readonly<{ poolKey: string; expected: ExpectedDeployment | null; checkpoint: number | null }> | null;
}>;

/** What the migration vertical receives: the supported route the launch recorded. */
export type MigrationSlotContext = Readonly<{ launchId: string; route: RecordedRoute }>;

/**
 * The integration contract for the coin page's financial verticals. Each
 * renders only where the fresh launch object allows it: `trade` for Buy/Sell
 * on the curve (Live) or on the recorded venue (Migrated, venue known),
 * `bid` during the opening round, and `migration` for Complete migration
 * (MigrationReady on a supported route). Each must still run its own fresh
 * preflight before signing. Omitted slots render honest placeholders.
 */
export type CoinActionSlots = Readonly<{
  trade?: (context: TradeSlotContext) => ReactNode;
  bid?: (context: BidSlotContext) => ReactNode;
  migration?: (context: MigrationSlotContext) => ReactNode;
}>;

function ClosedTrading() {
  return (
    <div className={styles.closedTrade} role="group" aria-label="Buy and sell (closed)">
      <button type="button" disabled>Buy</button>
      <button type="button" disabled>Sell</button>
    </div>
  );
}

function Pending({ children }: Readonly<{ children: ReactNode }>) {
  return <p className={styles.note}>{children}</p>;
}

/**
 * The execution slot: what can be done now and why, from the launch
 * object's lifecycle. It never shows an enabled control the launch object
 * does not allow, and never reopens the curve after migration.
 */
export function CoinExecution({ page, actions = {}, market = null }: Readonly<{
  page: CoinPage;
  actions?: CoinActionSlots;
  /** This app's market stream, when configured: its pushed rounds keep the bidder count current. */
  market?: Readonly<{ expected: ExpectedDeployment | null }> | null;
}>) {
  const { availability, launchId } = page;
  const coinType = page.fresh.status === "read" ? page.fresh.launch.memeType : "";
  const trade = (poolKey: string, venue: string) =>
    actions.trade?.({ launchId, coinType, poolKey, venue }) ?? (
      <Pending>
        Buy and sell on the {venue === "blast_curve" ? "bonding curve" : `${venueName(venue)} pool`} open here once
        trading is connected.
      </Pending>
    );

  switch (availability.kind) {
    case "unverified":
      return (
        <div className={styles.execution} data-availability={availability.kind}>
          <p className={styles.executionState}>Trading is unavailable. {availability.reason}</p>
          <ClosedTrading />
          <Pending>Nothing can be signed until the launch object can be read. Reload the page to try again.</Pending>
        </div>
      );
    case "opening-round":
      return <OpeningRoundExecution page={page} availability={availability} actions={actions} coinType={coinType} market={market} />;
    case "curve":
      return (
        <div className={styles.execution} data-availability={availability.kind}>

          {trade(`blast_curve:${launchId}`, "blast_curve")}
        </div>
      );
    case "migration-ready": {
      const { route } = availability;
      return (
        <div className={styles.execution} data-availability={availability.kind}>
          {route.supported
            ? (actions.migration?.({ launchId, route }) ?? (
                <Pending>Complete migration to {venueName(route.venue)} opens here once migration is connected.</Pending>
              ))
            : (
                <Pending>
                  This app cannot complete a {venueName(route.venue)} migration: {describeReason(route.reason ?? "unsupported route")}. Anyone may complete it
                  elsewhere; this page updates when it lands.
                </Pending>
              )}
        </div>
      );
    }
    case "venue":
      return (
        <div className={styles.execution} data-availability={availability.kind}>

          {trade(availability.poolKey, availability.route.venue)}
        </div>
      );
    case "venue-unavailable":
      return (
        <div data-availability={availability.kind}>
          {venueMarketCatchingUp(page) ? (
            <EmptyState
              row
              role="status"
              title="Market data is catching up"
              action={<ButtonLink href={`/coin/${launchId}`} size="sm">Reload</ButtonLink>}
            />
          ) : (
            <Pending>Trading on {venueName(availability.route.venue)} is unavailable: {describeReason(availability.reason)}.</Pending>
          )}
        </div>
      );
  }
}

function openingRoundBidders(
  { curve, launchId }: CoinPage,
  market: Readonly<{ expected: ExpectedDeployment | null }> | null,
): BidderCount | null {
  if (curve.state !== "available" && curve.state !== "stale") return null;
  const round = curve.data.launch.openingRound;
  if (!round) return null;
  return {
    count: round.bidderCount,
    stale: curve.state === "stale",
    live: market && { poolKey: `blast_curve:${launchId}`, expected: market.expected, checkpoint: curve.provenance.checkpoint },
  };
}

function OpeningRoundExecution({ page, availability, actions, coinType, market }: Readonly<{
  page: CoinPage;
  availability: Extract<CoinPage["availability"], { kind: "opening-round" }>;
  actions: CoinActionSlots;
  coinType: string;
  market: Readonly<{ expected: ExpectedDeployment | null }> | null;
}>) {
  const { launchId } = page;
  // Availability is `opening-round` only when the launch object was read.
  const launch = page.fresh.status === "read" ? page.fresh.launch : null;
  const readAtMs = page.fresh.status === "read" ? page.fresh.readAtMs : 0;
  const endsAtMs = availability.endsAtMs === null ? null : Number(availability.endsAtMs);
  const bid = launch
    ? actions.bid?.({
      launchId,
      coinType,
      round: {
        startsAtMs: launch.publicStartMs === null ? null : Number(launch.publicStartMs),
        endsAtMs,
        totalQuote: launch.openingRoundBids,
        quoteType: launch.quoteType,
        readAtMs,
      },
      bidders: openingRoundBidders(page, market),
    })
    : null;
  return (
    <div className={styles.execution} data-availability={availability.kind}>
      <p className={styles.executionState}>
        {endsAtMs !== null && readAtMs >= endsAtMs
          ? <>Opening round ended on <DateStamp at={endsAtMs} label="opening-round end time" />. Anyone can settle it.</>
          : "Opening round: bids are open."}
      </p>

      <ClosedTrading />
      {bid ?? <Pending>Opening-round bids open here once bidding is connected.</Pending>}
    </div>
  );
}
