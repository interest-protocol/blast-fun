import Link from "next/link";
import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { traderProfileKey, type TraderProfile } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { ActivityAmount, CompactTradeList, CompactTradeRow, Transaction, useTradeInspector, useTradeVisibility, type TradeExplorer, type TradeRowState, type TransactionExplorer } from "./CompactTradeList";
import { WalletAddress } from "./WalletAddress";
import { recentTrades } from "./recent-trades";
import { dustQuoteUsd, isTradeUnderDollar } from "./small-trades";
import { useTraderProfiles } from "./trader-profiles";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Disclosure } from "#web/components/blast-ui/Disclosure.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { memo, useState, type ReactNode } from "react";

import { Fact, Facts } from "../coin/Facts";
import { useCoinPriceCurrency } from "../chart/CoinPriceCurrency";
import { LIFECYCLE_LABEL } from "../coin/coin-view";
import { provenanceRecord } from "../primitives/provenance";
import { DataState } from "../primitives/DataState";
import { DataTable, type DataTableColumn } from "../primitives/DataTable";
import type { SectionState } from "../primitives/data-state";
import type { TradeTapeSnapshot } from "./trade-tape";
import styles from "./Activity.module.css";
import {
  activityKey,
  flowDisplay,
  initialList,
  listDisplay,
  type FlowState,
  type FlowView,
  type ListStaleness,
  type ListState,
  type ListView,
  type RowKey,
} from "./activity-model";
import { isActivityTrade, WINDOW_NAMES, type ActivityRow, type WindowName } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";

export { TradeListSkeleton, type TransactionExplorer } from "./CompactTradeList";

/** The coin's and its Quote's symbols and decimals; null decimals keep compact values unavailable. */
export type ActivityUnits = Readonly<{
  symbol: string;
  memeDecimals: number | null;
  coinType?: string | null;
  iconUrl?: string | null;
  quoteSymbol: string;
  quoteDecimals: number | null;
  quoteType?: string | null;
  quoteUsd?: string | null;
}>;

export type ActivityPending = "refresh" | "more-activity" | null;

export type ActivityViewProps = Readonly<{
  compact?: boolean;
  confirmedActivity?: ListState<ActivityRow>;
  launchId: string;
  activity: ListState<ActivityRow>;
  tape?: Readonly<{ recent: TradeTapeSnapshot; hold: (hold: boolean) => void }>;
  flow: FlowState;
  window: WindowName;
  units: ActivityUnits;
  explorer: TransactionExplorer | null;
  /** The linked record's position (`?activity=`), whose page the lists start at. */
  anchor: string | null;
  pending: ActivityPending;
  onRefresh: () => void;
  onMoreActivity: () => void;
  onShowNewerActivity: () => void;
  onWindow: (window: WindowName) => void;
}>;

// --- Amounts ---------------------------------------------------------------------------------------

type Unit = "quote" | "meme" | "sui";
type AmountEntry = Readonly<{ key: string; label: string; unit: Unit; hideLabel?: true; direction?: "in" | "out" }>;

/** The asset the swap returns to the trader. */
const TRADE_RECEIVED: Partial<Record<ActivityRow["kind"], "quote" | "meme">> = {
  curve_buy: "meme",
  curve_sell: "quote",
  venue_buy: "meme",
  venue_sell: "quote",
};

/** SUI's decimals: a protocol claim's creation-fee share is in SUI whatever the launch's Quote. */
const SUI_DECIMALS = 9;

/** Each amount key's name and coin, in the order rows list them. */
const AMOUNTS: readonly AmountEntry[] = [
  { key: "quote", label: "Payment", unit: "quote", hideLabel: true },
  { key: "bid", label: "Bid", unit: "quote" },
  { key: "bids", label: "Pot", unit: "quote" },
  { key: "meme", label: "Tokens", unit: "meme", hideLabel: true },
  { key: "refund_quote", label: "Refund", unit: "quote" },
  { key: "disposed_meme", label: "Unsold tokens", unit: "meme" },
  { key: "total_supply_after", label: "Supply after", unit: "meme" },
  { key: "sui", label: "SUI", unit: "sui", hideLabel: true },
  { key: "partner_meme", label: "Partner share", unit: "meme" },
  { key: "partner_quote", label: "Partner payment", unit: "quote" },
  { key: "partner_sui", label: "Partner SUI", unit: "sui" },
];

function unitOf(units: ActivityUnits, unit: Unit) {
  switch (unit) {
    case "quote":
      return { symbol: units.quoteSymbol, decimals: units.quoteDecimals, coinType: units.quoteType, iconUrl: null };
    case "meme":
      return { symbol: units.symbol, decimals: units.memeDecimals, coinType: units.coinType, iconUrl: units.iconUrl };
    case "sui":
      return { symbol: "SUI", decimals: SUI_DECIMALS, coinType: SUI_COIN_TYPE, iconUrl: null };
  }
}

function Amounts({ row, units }: Readonly<{ row: ActivityRow; units: ActivityUnits }>) {
  const { amounts } = row;
  const received = TRADE_RECEIVED[row.kind];
  const paid = received === "quote" ? "meme" : "quote";
  const definitions: readonly AmountEntry[] = received ? [
    { key: paid, label: "In", unit: paid, direction: "in" },
    { key: received, label: "Out", unit: received, direction: "out" },
  ] : AMOUNTS;
  const entries = definitions.filter(({ key }) => key in amounts);
  if (entries.length === 0) return <span className={styles.muted}>{row.kind === "unrecognized" ? "Unavailable" : "None"}</span>;
  return (
    <dl className={styles.amounts}>
      {entries.map(({ key, label, unit, hideLabel, direction }) => {
        const asset = unitOf(units, unit);
        const { coinType, iconUrl, decimals } = asset;
        const mark = !received && coinType ? <CoinMark coin={{ key: coinType, coinType, iconUrl: iconUrl ?? null }} size={16} /> : null;
        return (
          <div key={key}>
            <dt data-direction={direction} className={hideLabel && decimals !== null ? "sr-only" : undefined}>{label}</dt>
            <dd><ActivityAmount amount={amounts[key]} {...asset} iconOnly={!!received} mark={mark} /></dd>
          </div>
        );
      })}
    </dl>
  );
}

// --- Rows ------------------------------------------------------------------------------------------

/** What a classified row is, in words; the settlement's two rows differ by their amounts. */
function eventLabel(row: ActivityRow): string {
  switch (row.kind) {
    case "curve_buy":
      return row.source === "creator_pre_share" ? "Pre-share buy" : "Buy";
    case "curve_sell":
      return "Sell";
    case "opening_join":
      return "Opening-round join";
    case "opening_settlement":
      return "quote" in row.amounts ? "Settlement: pot buy" : "Settlement: round closed";
    case "opening_delivery":
      return "Opening-round delivery";
    case "lifecycle":
      return row.lifecycle ? LIFECYCLE_LABEL[row.lifecycle] : "Launch status changed";
    case "migration":
      return "Graduation";
    case "migration_allocation":
      return "Migration allocation";
    case "creator_fees_claimed":
      return "Creator fees claimed";
    case "owner_balances_claimed":
      return "Vault balances claimed";
    case "protocol_fees_claimed":
      return "Protocol fees claimed";
    case "reward_claimed":
      return "Vault rewards claimed";
    case "venue_buy":
      return "Venue buy";
    case "venue_sell":
      return "Venue sell";
    case "unrecognized":
      return "Other activity";
  }
}

function Address({ address }: Readonly<{ address: string | null }>) {
  if (address === null) return <span className={styles.muted}>Unavailable</span>;
  return <InspectValue value={address} label="address"><code className={styles.mono}>{shortId(address)}</code></InspectValue>;
}

/** Where a row comes from: a trade's origin, a venue swap's pool, or the address a payment went to. */
function sourceLabel(row: ActivityRow): ReactNode {
  switch (row.source) {
    case "user":
      return "Bonding curve";
    case "creator_pre_share":
      return "Before launch was shared";
    case "opening_round_settlement":
      return "Opening-round settlement";
    case null:
      switch (row.kind) {
        case "lifecycle":
          return "Launch";
        case "migration":
          return "Graduation";
        case "creator_fees_claimed":
          return "Bonding curve's creator fees";
        case "owner_balances_claimed":
        case "reward_claimed":
          return "Launch vault";
        case "unrecognized":
          return <span className={styles.muted}>Unavailable</span>;
        default:
          return "Opening round";
      }
  }
  if (row.kind === "venue_buy" || row.kind === "venue_sell") return <DexIdentity venue={row.source.split(":")[0]!} iconOnly size={20} />;
  if (row.kind === "reward_claimed") return <>Relayed by <Address address={row.source} /></>;
  return (
    <>
      {row.kind === "protocol_fees_claimed" ? "Paid to the treasury " : "Paid to "}
      <Address address={row.source} />
    </>
  );
}

type Shown<V> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "rows" | "flow"; view: V; stale: ListStaleness | null }>;

/** A list's or the flow's display in the primitives' terms, reasons in words. */
function sectionOf<V extends Readonly<{ provenance: Provenance }>>(display: Shown<V>): SectionState<V> {
  switch (display.kind) {
    case "loading":
      return { status: "loading" };
    case "unavailable":
      return { status: "unavailable", reason: display.reason };
    default: {
      const provenance = provenanceRecord(display.view.provenance);
      return display.stale
        ? { status: "stale", value: display.view, provenance, reason: display.stale.cause }
        : { status: "ready", value: display.view, provenance };
    }
  }
}

const WINDOW_WORDS: Readonly<Record<Exclude<WindowName, "all">, string>> = {
  "5m": "5 minutes",
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
};

function FlowSummary({ view, window, units, onWindow }: Readonly<{ view: FlowView; window: WindowName; units: ActivityUnits; onWindow: (window: WindowName) => void }>) {
  const flow = view.flow.windows[window];
  return (
    <div className={styles.body}>
      <div className={styles.windows} role="group" aria-label="Flow window">
        {WINDOW_NAMES.map((name) => (
          <button key={name} className={styles.window} type="button" aria-pressed={name === window} onClick={() => onWindow(name)}>
            {name === "all" ? "All time" : name}
          </button>
        ))}
      </div>
      <p className={styles.note}>Bonding curve trades only. Opening-round settlement is excluded.</p>
      <Facts label={`Flow, ${window === "all" ? "all time" : `last ${WINDOW_WORDS[window]}`}`}>
        <Fact term={`Net ${units.quoteSymbol} flow`}><ActivityAmount amount={flow.netQuoteFlow} {...unitOf(units, "quote")} signed /></Fact>
        <Fact term="Buyers">{flow.buyers.toLocaleString("en-US")}</Fact>
        <Fact term="Sellers">{flow.sellers.toLocaleString("en-US")}</Fact>
      </Facts>

    </div>
  );
}

function Newer({ onShow, subject }: Readonly<{ onShow: () => void; subject: string }>) {
  return (
    <p className={styles.note} role="status">
      Newer {subject} is available.{" "}
      <button className={styles.textButton} type="button" onClick={onShow}>
        Show latest
      </button>
    </p>
  );
}

function More({
  view,
  failed,
  pending,
  subject,
  onMore,
}: Readonly<{ view: ListView<unknown>; failed: string | null; pending: boolean; subject: string; onMore: () => void }>) {
  return (
    <>
      {failed ? (
        <p className={styles.note} role="status">
          Older {subject} couldn’t load. Try again.
        </p>
      ) : null}
      {view.next ? (
        <button className={styles.button} type="button" onClick={onMore} disabled={pending} aria-busy={pending || undefined}>
          {pending ? <LoadingIndicator label={`Loading older ${subject}`}>Load older {subject}</LoadingIndicator> : `Load older ${subject}`}
        </button>
      ) : null}
    </>
  );
}

/** The positions a list shows, or null while it shows no rows. */
function shownKeys<Row>(state: ListState<Row>, key: RowKey<Row>): readonly string[] | null {
  const display = listDisplay(state);
  return display.kind === "rows" ? display.view.rows.map(key) : null;
}

function LinkNote({ id, launchId, anchor, shown, unavailable }: Readonly<{ id: string; launchId: string; anchor: string; shown: readonly string[] | null; unavailable: boolean }>) {
  let note = unavailable ? "Linked activity couldn’t load." : "Loading linked activity.";
  if (shown !== null) {
    note = shown.includes(anchor)
      ? "Showing the linked event and earlier activity."
      : shown.length > 0 ? "Linked event unavailable. Showing earlier activity." : "No activity found at or before the linked event.";
  }
  return (
    <p className={styles.note} id={id}>
      {note}{" "}
      <Link className={styles.link} href={`/coin/${launchId}`} prefetch={false}>Show the newest activity</Link>
    </p>
  );
}

function LaunchActivity({ props }: Readonly<{ props: ActivityViewProps }>) {
  const { launchId, activity, units, explorer, anchor, pending } = props;
  const link = (position: string) => `/coin/${launchId}?activity=${position}`;
  const columns: DataTableColumn<ActivityRow>[] = [
    { header: "Event", cell: eventLabel },
    {
      header: "Date",
      cell: (row) => <DateStamp at={row.timestampMs} href={link(row.position)} className={styles.link} label="Link to event" />,
    },
    { header: "Where", cell: sourceLabel },
    { header: "Address", cell: (row) => row.actor ? <WalletAddress address={row.actor} row={row} label="address"><code className={styles.mono}>{shortId(row.actor)}</code></WalletAddress> : <Address address={null} /> },
    { header: "Amounts", cell: (row) => <Amounts row={row} units={units} /> },
    { header: "Transaction", cell: (row) => <Transaction digest={row.digest} explorer={explorer} /> },
  ];
  return (
    <section className={styles.section} aria-labelledby={`${launchId}-launch-activity`}>
      <h3 className={styles.heading} id={`${launchId}-launch-activity`}>Launch activity</h3>
      {anchor ? (
        <LinkNote
          id={`${launchId}-activity-link`}
          launchId={launchId}
          anchor={anchor}
          shown={shownKeys(activity, activityKey)}
          unavailable={listDisplay(activity).kind === "unavailable"}
        />
      ) : null}
      {activity.newer ? <Newer subject="activity" onShow={props.onShowNewerActivity} /> : null}
      <DataState
        state={sectionOf(listDisplay(activity))}
        subject="launch activity"
        loading="Loading launch activity…"
        empty="No completed launch activity yet."
        recovery="Use Refresh activity to try again."
      >
        {(view) =>
          view.rows.length === 0 ? (
            // A list cut at a link is not the launch's whole activity; its note says what was cut.
            anchor ? null : <p className={styles.note}>No completed launch activity yet.</p>
          ) : (
            <div className={styles.body}>

              <DataTable
                caption="Launch activity, newest first"
                columns={columns}
                rows={view.rows}
                rowKey={(row) => row.position}
                rowAnchor={(row) => ({ id: `activity-${row.position}`, current: row.position === anchor })}
              />
              <More view={view} failed={activity.moreFailed} pending={pending === "more-activity"} subject="activity" onMore={props.onMoreActivity} />
            </div>
          )
        }
      </DataState>
    </section>
  );
}

/**
 * The Activity destination: the curve's windowed flow and the launch's
 * completed activity, including exchange trades after graduation.
 */
export function ActivityView(props: ActivityViewProps): ReactNode {
  if (props.compact && !props.anchor) return <CompactTrades props={props} />;
  const { flow, window, units, pending } = props;
  return (
    <div className={styles.activity}>
      <section className={styles.section} aria-labelledby={`${props.launchId}-flow`}>
        <h3 className={styles.heading} id={`${props.launchId}-flow`}>Flow</h3>
        <DataState
          state={sectionOf(flowDisplay(flow))}
          subject="flow"
          loading="Loading trade flow…"
          recovery="Use Refresh activity to try again."
        >
          {(view) => <FlowSummary view={view} window={window} units={units} onWindow={props.onWindow} />}
        </DataState>
      </section>
      <LaunchActivity props={props} />
      <button
        className={styles.button}
        type="button"
        onClick={props.onRefresh}
        disabled={pending === "refresh"}
        aria-busy={pending === "refresh" || undefined}
      >
        {pending === "refresh" ? <LoadingIndicator label="Refreshing activity">Refresh activity</LoadingIndicator> : "Refresh activity"}
      </button>
    </div>
  );
}

/** Trades use the same paged feed; lifecycle records remain in the detailed ledger. */
function CompactTrades({ props }: Readonly<{ props: ActivityViewProps }>) {
  const display = listDisplay(props.activity);
  if (display.kind === "loading") return <SkeletonText>Reading trades</SkeletonText>;
  if (display.kind === "unavailable") return <EmptyState title="Trades couldn’t load" role="alert" action={<Button size="sm" onClick={props.onRefresh}>Try again</Button>} />;
  const tape = props.tape;
  const rows = tape?.recent.rows ?? recentTrades(display.view.rows);
  const profileSource = props.confirmedActivity ? { launchId: props.launchId, activity: props.confirmedActivity } : undefined;
  return <>
    {display.stale ? <p className={styles.note} role="status">Trade updates delayed.</p> : null}
    {props.activity.newer ? <Newer subject="trades" onShow={props.onShowNewerActivity} /> : null}
    <TradeList key={props.launchId} rows={rows} availableRows={display.view.rows.filter(isActivityTrade)}
      units={props.units} explorer={props.explorer} profileSource={profileSource} next={display.view.next}
      entering={tape?.recent.entering} leaving={tape?.recent.leaving} slide={tape?.recent.slide} hold={tape?.hold} />
    <Disclosure title="Launch activity"><ActivityView {...props} compact={false} /></Disclosure>
  </>;
}

type TradeListProps = Readonly<{
  units: ActivityUnits;
  explorer: TradeExplorer;
  profileSource?: Readonly<{ launchId: string; activity: ListState<ActivityRow> }>;
  next: string | null;
}>;

const NO_CONFIRMED_ACTIVITY = initialList<ActivityRow>();

export const TradeList = memo(function TradeList({ rows, availableRows, units, explorer, profileSource, next, entering, leaving, slide, hold }: TradeListProps & Readonly<{
  rows: readonly ActivityRow[];
  availableRows?: readonly ActivityRow[];
  entering?: string | null;
  leaving?: ActivityRow | null;
  slide?: boolean;
  hold?: (hold: boolean) => void;
}>) {
  const currency = useCoinPriceCurrency();
  const quoteUsd = dustQuoteUsd(units.quoteType, currency, units.quoteUsd);
  const filter = useState(true);
  const visibility = useTradeVisibility(rows, availableRows,
    (row) => isTradeUnderDollar({ usd: row.volumeUsd, quote: row.amounts.quote, decimals: units.quoteDecimals, quoteUsd }),
    filter,
  );
  const profiles = useTraderProfiles(profileSource?.launchId ?? "", profileSource?.activity ?? NO_CONFIRMED_ACTIVITY, profileSource !== undefined, visibility.rows, leaving);
  if (!rows.length) return <EmptyState title={next ? "No trades in this page of activity" : "No trades in the loaded activity"} />;
  return <CompactTradeList visibility={visibility} entering={entering} leaving={leaving} slide={slide} hold={hold}>
    {(row, state) => <LaunchTradeRow key={row.position} {...state} row={row} units={units} explorer={explorer}
      profile={row.actor ? profiles[traderProfileKey({ address: row.actor, timestampMs: row.timestampMs })] ?? null : null}
    />}
  </CompactTradeList>;
});

const LaunchTradeRow = memo(function LaunchTradeRow({ row, units, explorer, profile, ...state }: TradeRowState & Readonly<{
  row: ActivityRow;
  units: ActivityUnits;
  explorer: TradeExplorer;
  profile: TraderProfile | null;
}>) {
  const onInspect = useTradeInspector();
  return <CompactTradeRow
    {...state}
    side={row.kind === "curve_sell" || row.kind === "venue_sell" ? "sell" : "buy"}
    trader={row.actor ? <WalletAddress address={row.actor} row={row} label="trader address" onInspect={onInspect} /> : <span>Unknown trader</span>}
    profile={profile}
    wallet={row.actor}
    timestampMs={row.timestampMs}
    tokens={<ActivityAmount amount={row.amounts.meme} {...unitOf(units, "meme")} compact iconOnly onInspect={onInspect} />}
    quote={<ActivityAmount amount={row.amounts.quote} {...unitOf(units, "quote")} compact iconOnly onInspect={onInspect} />}
    digest={row.digest}
    explorer={explorer}
  />;
});
