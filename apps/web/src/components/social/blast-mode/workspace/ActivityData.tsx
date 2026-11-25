"use client";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Pick } from "../../coin-home/HomeControls";
import { DelayedNote, LoadFailed, NothingHere, RefreshFailed } from "./DataStates";
import { workspaceScrollOwner } from "./scroll-owner";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { isValidStructTag } from "@mysten/sui/utils";
import { atLeastPow10, exactAtoms, exactDecimal, fixedExact, qtyExact } from "@blast/core/web/exact-amount.ts";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { PendingStatus } from "#web/components/blast-ui/Skeleton.tsx";
import { RowsSkeleton } from "./RowsSkeleton";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { SOCIAL_FEED_DELAYED_LAG_MS } from "@blast/core/web/contracts/feed.ts";
import type {
  HomeActivityStreamEvent,
  HomeActivityStreamPage,
} from "@blast/core/web/contracts/home.ts";
import { bxAgo } from "@blast/core/web/format.ts";
import { VerifiedBadge } from "#web/components/blast-ui/Icons.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { coinFigure } from "../../coin-home/home-model";
import { QuoteMark } from "../../coin-home/glyphs";
import { ActorAvatar } from "./ActorCell";
import { actorIdentity } from "./actor-identity";
import { CoinPageLink, PanelAddButton, RefreshButton } from "./CoinsRows";
import { assetOnScreen, canonicalCoinType } from "./coin-row-model";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { useWorkspace } from "./workspace-context";
import { NETWORKS } from "@blast/core/modules/social/blast-workspace/setup.ts";
import rowStyles from "./CoinsData.module.css";
import styles from "./ActivityData.module.css";
import { ActivityCursorError, activityStreamQuery } from "./activity-stream-query";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

export function ActivityData() {
  const { snapshot, presentation } = useWorkspace();
  return presentation.mode_open &&
    presentation.document_visible &&
    !snapshot.data.collapsed &&
    snapshot.data.selected_view === "Activity" ? (
    <ActivityContent />
  ) : null;
}

function useActivityPage() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Activity;
  const page = controls.page ?? 1;
  const rows = controls.rows ?? 20;
  const cursors = controls.cursors ?? [null];
  const cursor = cursors[page - 1] ?? null;
  const [restarted, setRestarted] = useState(false);
  const [previousResult, setPreviousResult] = useState<{
    window: typeof controls.window;
    rows: number;
    cursor: string | null;
    page: number;
    data: HomeActivityStreamPage;
  } | null>(null);
  const client = useAppQueryClient();
  const read = useQuery(
    {
      ...activityStreamQuery(controls.window, rows, cursor),
    },
    client,
  );
  useEffect(() => {
    if (!read.data) return;
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- Keep the last successful display across a different query key's pending/error state.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Preserve the last successful public page while a different query key loads.
    setPreviousResult({
      window: controls.window,
      rows,
      cursor,
      page,
      data: read.data,
    });
  }, [read.data, controls.window, rows, cursor, page]);
  const previous =
    previousResult?.window === controls.window && previousResult.rows === rows
      ? previousResult
      : null;
  const data = read.data ?? previous?.data;
  const showingPreviousPage =
    !read.data && !!previous && previous.cursor !== cursor;
  const failedTargetPage = read.isError && showingPreviousPage;
  useEffect(() => {
    if (cursor === null || !(read.error instanceof ActivityCursorError)) return;
    dispatch.patchDataControls("Activity", {
      ...controls,
      page: 1,
      cursors: [null],
    });
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- A refused saved traversal restarts from the public first page, preserving the saved anchor.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Recover a refused saved cursor to the first public page.
    setRestarted(true);
  }, [cursor, read.error, controls, dispatch]);
  const change = (window: typeof controls.window) => {
    setRestarted(false);
    dispatch.patchDataControls("Activity", {
      ...controls,
      window,
      page: 1,
      cursors: [null],
      navigation: { ...controls.navigation, scroll_top: 0, anchor: null },
    });
  };
  const selectPage = (next: number) => {
    if (next > page && (read.isFetching || !read.data)) return;
    const nextCursors = [...cursors];
    if (next === page + 1 && read.data?.next_cursor)
      nextCursors[next - 1] = read.data.next_cursor;
    dispatch.patchDataControls("Activity", {
      ...controls,
      page: next,
      rows,
      cursors: nextCursors,
      navigation: { ...controls.navigation, scroll_top: 0, anchor: null },
    });
  };
  return {
    controls,
    page,
    cursors,
    restarted,
    read,
    previous,
    data,
    showingPreviousPage,
    failedTargetPage,
    change,
    selectPage,
  };
}

function ActivityContent() {
  const state = useActivityPage();
  const { controls, page, read, showingPreviousPage, change } = state;
  return (
    <>
      <div className={styles.controls}>
        <Pick
          label="Activity window"
          value={controls.window}
          options={["1h", "24h"] as const}
          labels={{ "1h": "1h", "24h": "24h" }}
          onPick={change}
        />
        <RefreshButton
          busy={read.isFetching}
          label="Refresh activity"
          onRefresh={() => void read.refetch()}
          title="Refresh activity"
        />
        {read.isFetching && showingPreviousPage && (
          <PendingStatus label={`Loading activity page ${page}`} />
        )}
      </div>
      <ActivityStatus state={state} />
      <ActivityResults state={state} />
    </>
  );
}

type ActivityPageState = ReturnType<typeof useActivityPage>;

function ActivityStatus({ state }: Readonly<{ state: ActivityPageState }>) {
  const { restarted, data, read, previous, showingPreviousPage } = state;
  return (
    <>
      {restarted && (
        <EmptyState role="status" row title="Activity restarted from the latest page">Your controls and asset panels are kept.</EmptyState>
      )}
      {data && data.as_of.lag_ms > SOCIAL_FEED_DELAYED_LAG_MS && (
        <DelayedNote />
      )}
      <ActivityReadProblem state={state} />
      {showingPreviousPage && !read.isError && (
        <EmptyState role="status" row title={`Showing page ${previous!.page}`} />
      )}
      {!data && !read.isError && (
        <RowsSkeleton label="Loading activity" />
      )}
    </>
  );
}

function ActivityReadProblem({ state }: Readonly<{ state: ActivityPageState }>) {
  const { read, failedTargetPage, page, previous, data } = state;
  if (!read.isError || read.error instanceof ActivityCursorError) return null;
  return (
    !data && !failedTargetPage ? (
      <LoadFailed onRetry={() => void read.refetch()} title="Activity could not load" />
    ) : (
      <RefreshFailed onRetry={() => void read.refetch()} title={failedTargetPage ? `Page ${page} could not load` : "Activity could not refresh"}>
        {failedTargetPage ? `Showing page ${previous!.page}.` : undefined}
      </RefreshFailed>
    )
  );
}

function ActivityResults({ state }: Readonly<{ state: ActivityPageState }>) {
  const { data, showingPreviousPage, read, page, cursors, selectPage } = state;
  if (!data) return null;
  return (
    <>
      <ActivityRows
        events={data.events}
        pending={showingPreviousPage}
        busy={read.isFetching}
        nowMs={data.clock_ms}
      />
      {!showingPreviousPage && data.events.length === 0 && (
        <NothingHere title="No activity in this window">Try the other window or refresh.</NothingHere>
      )}
      <div className={styles.footer}>
        <Pager
          what="events"
          page={page}
          pages={Math.max(
            page,
            cursors.length,
            page + (read.data?.next_cursor ? 1 : 0),
          )}
          onPage={selectPage}
        />
      </div>
    </>
  );
}

function ActivityRows({
  events,
  pending,
  busy,
  nowMs,
}: Readonly<{
  events: readonly HomeActivityStreamEvent[];
  pending: boolean;
  busy: boolean;
  nowMs: number;
}>) {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Activity;
  const list = useRef<HTMLOListElement>(null);
  const coverageId = useId();
  useLayoutEffect(() => {
    const localBody = list.current?.closest<HTMLElement>("#workspace-data-panel");
    const body = localBody ? workspaceScrollOwner(localBody) : null;
    if (!body || pending) return;
    const elements = [
      ...list.current!.querySelectorAll<HTMLElement>("[data-workspace-event]"),
    ];
    const anchor = controls.navigation.anchor;
    const exact =
      anchor &&
      elements.find(
        (element) => element.dataset.workspaceEvent === anchor.entry_id,
      );
    const row =
      exact ||
      (anchor && elements[Math.min(anchor.index, elements.length - 1)]);
    if (anchor && row) {
      body.scrollTop +=
        row.getBoundingClientRect().top -
        body.getBoundingClientRect().top -
        anchor.offset;
      if (!exact)
        dispatch.patchDataControls("Activity", {
          ...controls,
          navigation: {
            ...controls.navigation,
            anchor: {
              ...anchor,
              entry_id: row.dataset.workspaceEvent!,
              index: elements.indexOf(row),
            },
          },
        });
    } else body.scrollTop = controls.navigation.scroll_top;
  });
  return (
    <>
    <p className={rowStyles.visuallyHidden} id={coverageId}>
      Trades on every venue and indexed presale commitments.
    </p>
    <ol
      aria-label="Indexed activity"
      aria-describedby={coverageId}
      aria-busy={busy}
      className={rowStyles.list}
      ref={list}
    >
      {events.map((event) => (
        <ActivityRow event={event} key={event.entry_id} nowMs={nowMs} pending={pending} />
      ))}
    </ol>
    </>
  );
}

type StreamQuote = NonNullable<HomeActivityStreamEvent["quote"]>;

function ActivityRow({
  event,
  pending,
  nowMs,
}: Readonly<{ event: HomeActivityStreamEvent; pending: boolean; nowMs: number }>) {
  const { snapshot, dispatch } = useWorkspace();
  const { coin, actor } = event;
  const identity = actorIdentity(actor);
  const canonical = isCanonicalCoin(coin);
  const open = canonical && assetOnScreen(snapshot, canonicalCoinType(coin.coin_type), coin.network);
  return (
    <li className={rowStyles.row} data-on-screen={open} data-workspace-event={event.entry_id}>
      <div className={rowStyles.head} data-cols="event">
        <ActorAvatar identity={identity} size={28} />
        <span className={rowStyles.text}>
          {/* Line one is who; line two is what they did to which coin, so neither crowds out the name at rail width. */}
          <span className={styles.sentence}>
            {actor.type === "account" ? (
              <>
                <Link className={styles.actor} href={actor.path} prefetch={false}>{identity.kind === "account" ? identity.name : actor.callsign}</Link>
                {actor.verified ? <VerifiedBadge className={styles.verified} /> : null}
              </>
            ) : (
              <InspectValue label="wallet address" value={actor.address}>
                <span className={`${styles.actor} mono`}>{actor.short}</span>
              </InspectValue>
            )}
          </span>
          <ActivityWhat event={event} />
        </span>
        <ActivityFigures event={event} nowMs={nowMs} />
        <PanelAddButton
          disabled={!canonical || pending}
          open={open}
          symbol={coin.symbol}
          onAdd={() => {
            const id = dispatch.add({
              panel_id: crypto.randomUUID(),
              chain: coin.chain,
              network: coin.network,
              coin_type: coin.coin_type,
              presale_id: coin.presale_id,
            });
            if (coin.lifecycle === "migrated")
              dispatch.patchPanel(id, { active_namespace: "coin" });
          }}
        />
      </div>
    </li>
  );
}

/** Whether the event's coin is a mainnet-shaped Sui asset a panel can open. */
function isCanonicalCoin(coin: HomeActivityStreamEvent["coin"]): boolean {
  return (
    coin.chain === "sui" &&
    NETWORKS.includes(coin.network) &&
    isValidStructTag(coin.coin_type) &&
    (coin.presale_id === null || SUI_OBJECT_ID_PATTERN.test(coin.presale_id))
  );
}

function activityVerb(kind: HomeActivityStreamEvent["kind"]): string {
  if (kind === "trade_buy") return "bought";
  if (kind === "trade_sell") return "sold";
  return "committed to";
}

/** Line two: "bought 1,031 <mark> SYM", or "committed to <mark> SYM"; the coin opens its own page when it has one. */
function ActivityWhat({ event }: Readonly<{ event: HomeActivityStreamEvent }>) {
  const { coin } = event;
  const tokens = event.tokens === null ? null : exactAtoms(event.tokens, coin.decimals);
  const chip = (
    <>
      <CoinMark
        coin={{ key: coin.presale_id ?? coin.coin_type, coinType: coin.coin_type, symbol: coin.symbol, iconUrl: coin.icon_url, round: true }}
        size={16}
      />
      <span className={styles.symbol}>{coin.symbol}</span>
    </>
  );
  return (
    <span className={rowStyles.t2}>
      <span className={styles.verb}>{activityVerb(event.kind)}</span>
      {event.kind !== "presale_commit" && tokens !== null && (
        <InspectValue
          label={`${coin.symbol} amount`}
          value={`${fixedExact(tokens, coin.decimals)} ${coin.symbol} (${event.tokens} atoms)`}
        >
          <span className={styles.amount}>{quantityOnly(nonzeroFigure(event.tokens!, coin.symbol, coin.decimals), coin.symbol)}</span>
        </InspectValue>
      )}
      {coin.presale_id !== null && SUI_OBJECT_ID_PATTERN.test(coin.presale_id) ? (
        <CoinPageLink className={`${rowStyles.coinLink} ${styles.coin}`} presaleId={coin.presale_id} symbol={coin.symbol}>
          {chip}
        </CoinPageLink>
      ) : (
        <InspectValue label="asset identifier" value={coin.coin_type}>
          <span className={styles.coin}>{chip}</span>
        </InspectValue>
      )}
    </span>
  );
}

/** The quote amount exactly: decimal with its symbol and atoms, or atoms of its type when decimals are unknown. */
function exactQuoteText(quote: StreamQuote): string {
  const amount = quote.quote_decimals === null ? null : exactAtoms(quote.atoms, quote.quote_decimals);
  return amount === null
    ? `${quote.atoms} atoms of ${quote.quote_type}`
    : `${fixedExact(amount, quote.quote_decimals!)} ${quote.quote_symbol ?? quote.quote_type} (${quote.atoms} atoms)`;
}

/** The right column: USD at the event (or the quote amount with its mark), over the relative time. */
function ActivityFigures({ event, nowMs }: Readonly<{ event: HomeActivityStreamEvent; nowMs: number }>) {
  const at = new Date(event.occurred_at_ms).toISOString();
  return (
    <span className={rowStyles.figs}>
      <span className={rowStyles.figTop}>
        <ActivityAmount quote={event.quote} />
      </span>
      <span className={rowStyles.figSub}>
        <InspectValue
          label="event time and transaction"
          value={`${at.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")} · ${event.digest ?? "Transaction unavailable"}`}
        >
          <time dateTime={at}>{bxAgo(event.occurred_at_ms, nowMs)}</time>
        </InspectValue>
      </span>
    </span>
  );
}

function ActivityAmount({ quote }: Readonly<{ quote: HomeActivityStreamEvent["quote"] }>) {
  if (!quote) return <span className={styles.unavailable}>Amount unavailable</span>;
  const exactQuote = exactQuoteText(quote);
  if (quote.usd !== null)
    return (
      <InspectValue
        label="USD at event"
        value={`${quote.usd} USD${quote.usd_complete ? "" : " (partial)"} · ${exactQuote}`}
      >
        {usdFigure(quote.usd, quote.atoms)}
        {quote.usd_complete ? "" : "+"}
      </InspectValue>
    );
  return (
    <>
      {quote.quote_symbol ? <span className={rowStyles.mark}><QuoteMark symbol={quote.quote_symbol} /></span> : null}
      <InspectValue label="quote amount" value={exactQuote}>
        {nonzeroFigure(quote.atoms, quote.quote_symbol, quote.quote_decimals) ?? `${quote.atoms} atoms`}
      </InspectValue>
    </>
  );
}

/** The number of a coin figure; the symbol is drawn beside it in the coin's own weight. */
function quantityOnly(figure: string | null, symbol: string): string {
  if (figure === null) return "—";
  return figure.endsWith(` ${symbol}`) ? figure.slice(0, -(symbol.length + 1)) : figure;
}

/**
 * A coin figure to four places; a nonzero amount below that reads `<0.0001`, never `0`.
 * From 10,000 it is the row's compact figure (`47,619`, `99.31M`) so a whale trade fits
 * the column (audit F34); the exact amount stays in the inspector.
 */
function nonzeroFigure(atoms: string, symbol: string | null, decimals: number | null): string | null {
  const amount = exactAtoms(atoms, decimals);
  if (amount && atLeastPow10(amount, 4)) return symbol === null ? qtyExact(amount) : `${qtyExact(amount)} ${symbol}`;
  const figure = coinFigure(atoms, symbol, decimals, 4);
  if (figure === null || symbol === null) return figure;
  return atoms !== "0" && /^0(\.0+)? /.test(figure) ? `<0.0001 ${symbol}` : figure;
}

/** The indexer's two-place dollars, grouped, compact from $10,000 (`$1.23M`); a priced nonzero trade below a cent reads `<$0.01`. */
function usdFigure(usd: string, atoms: string): string {
  const exact = exactDecimal(usd);
  if (exact && atLeastPow10(exact, 4)) return `$${qtyExact(exact)}`;
  const value = Number(usd);
  if (value === 0 && atoms !== "0") return "<$0.01";
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
