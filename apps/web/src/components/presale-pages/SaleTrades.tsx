"use client";

import { hashKey, replaceEqualDeep, useQuery, type QueryClient } from "@tanstack/react-query";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";

import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { PresaleMarketTrade } from "@blast/core/modules/live/presale-market-frames.ts";
import { n } from "@blast/core/modules/presale/presentation.ts";
import { activityEntryId } from "@blast/core/modules/social/contracts/feed-entries.ts";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";
import type { HomeThreadPage } from "@blast/core/web/contracts/home.ts";
import type { SocialPresaleDetail } from "@blast/core/web/contracts/presales.ts";
import type { SocialExplorer } from "@blast/core/web/contracts/settings.ts";
import { exactDecimal, exactText } from "@blast/core/web/exact-amount.ts";
import { shortAddress, usd } from "@blast/core/web/format.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { ActivityAmount, CompactTradeList, CompactTradeRow, TradeListSkeleton, useTradeInspector, useTradeVisibility, type TradeRowState } from "#web/components/launchpad/activity/CompactTradeList.tsx";
import { WalletAddress } from "#web/components/launchpad/activity/WalletAddress.tsx";
import { createRecentTradeTape } from "#web/components/launchpad/activity/trade-tape.ts";
import { isHomeTradeUnderDollar } from "#web/components/launchpad/activity/small-trades.ts";
import { ChartTradeContext } from "#web/components/launchpad/chart/chart-trade-context.ts";
import { fetchHomeThread } from "#web/components/social/coin-home/home-client.ts";
import { actorName } from "#web/components/social/coin-home/home-model.ts";
import {
  browserGapTimers,
  hintedGap,
  NEW_POSTS_MIN_GAP_MS,
  NEW_POSTS_POLL_MS,
  type FreshnessHint,
} from "#web/components/social/home/feed-freshness.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { presaleFreshness } from "./presale-freshness.ts";
import { usePresaleMarketStream } from "./use-presale-market-stream.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";


const LIMIT = 10;

function tradeRows(page: HomeThreadPage) {
  return page.participants.flatMap(({ actor, events }) =>
    (events ?? []).filter((event) => event.kind === "trade_buy" || event.kind === "trade_sell")
      .map((event) => ({ actor, event, position: event.activity_id })),
  ).sort((a, b) => compareEventCursors(b.position, a.position));
}

type TradeRead = Readonly<{
  rows: ReturnType<typeof tradeRows>;
  clockMs: number;
  checkpoint: number;
  receivedAt: number | null;
  streamed?: string;
}>;

function streamedRow(frame: PresaleMarketTrade, sale: SocialPresaleDetail["presale"]): TradeRead["rows"][number] {
  const quote = frame.quote_type === sale.quote_type
    ? { symbol: sale.quote_symbol, decimals: sale.quote_decimals }
    : createQuoteOf(frame.quote_type);
  const dollars = exactDecimal(frame.usd);
  return {
    position: frame.cursor,
    actor: { type: "address", address: frame.actor, short: shortAddress(frame.actor) },
    event: {
      activity_id: frame.cursor,
      entry_id: activityEntryId(frame.cursor),
      kind: frame.kind,
      occurred_at_ms: frame.timestamp_ms,
      digest: frame.digest,
      tokens: frame.coin_atoms,
      quote: {
        quote_type: frame.quote_type,
        quote_symbol: quote?.symbol ?? null,
        quote_decimals: quote?.decimals ?? null,
        atoms: frame.quote_atoms,
        usd: dollars ? exactText(dollars) : null,
        usd_complete: dollars !== null,
      },
      has_why: false,
      refund: null,
    },
  };
}

function checkpointOf(position: string) {
  return Number(position.split(":", 1)[0]);
}

function tradeArrival(previous: TradeRead | undefined, rows: TradeRead["rows"], hint?: FreshnessHint) {
  const head = rows[0];
  if (!head) return null;
  const latest = previous?.rows[0];
  const order = latest ? compareEventCursors(head.position, latest.position) : 1;
  if (order === 0 && previous?.receivedAt != null) return previous.receivedAt;
  if (order < 0 || !hint?.trade || document.hidden) return null;
  // A poll can paint the trade before its hint is read. Only an indexed row can cue.
  const cursor = hint.trade.cursor;
  return (head.position === cursor || (order > 0 && rows.some((row) => row.position === cursor)))
    ? performance.now() : null;
}

function createSaleTape(client: QueryClient, key: ReturnType<typeof queryKeys.home.presaleTrades>) {
  const hash = hashKey(key);
  return createRecentTradeTape({
    state() {
      const read = client.getQueryData<TradeRead>(key);
      return read ? { rows: read.rows, quiet: false } : null;
    },
    subscribe(sync) {
      return client.getQueryCache().subscribe((event) => {
        if (event.type === "updated" && event.query.queryHash === hash) sync();
      });
    },
  }, LIMIT);
}

function useSaleTradeFeed(sale: SocialPresaleDetail["presale"]) {
  const { presale_id: presaleId, coin_type: coinType } = sale;
  const client = useAppQueryClient();
  const key = useMemo(() => queryKeys.home.presaleTrades(presaleId), [presaleId]);
  const pending = useRef<FreshnessHint | undefined>(undefined);
  const hiddenAt = useRef(-Infinity);
  const { data, isPending, refetch } = useQuery<TradeRead>({
    queryKey: key,
    async queryFn({ signal }) {
      const target = pending.current;
      const previous = client.getQueryData<TradeRead>(key);
      const latest = previous?.rows[0];
      // Catch-up and fallback reads must also include trades already on screen.
      const checkpoint = Math.max(
        target?.trade?.checkpoint ?? -1,
        latest ? checkpointOf(latest.position) : -1,
      );
      const page = await fetchHomeThread(presaleId, "24h", null, signal, {
        at: checkpoint >= 0 ? checkpoint : undefined,
        exactTradeUsd: true,
      });
      if (!signal.aborted && pending.current === target) pending.current = undefined;
      const rows = tradeRows(page);
      const visibleHint = target && target.atMs > hiddenAt.current ? target : undefined;
      return { rows, clockMs: page.clock_ms, checkpoint: page.as_of.checkpoint, receivedAt: tradeArrival(previous, rows, visibleHint) };
    },
    structuralSharing(oldData, newData) {
      const previous = oldData as TradeRead | undefined;
      const next = newData as TradeRead;
      if (!previous || next.streamed) return replaceEqualDeep(previous, next);
      if (previous.checkpoint > next.checkpoint || previous.clockMs > next.clockMs) return previous;
      // A snapshot can finish while a newer confirmed trade is already on screen.
      const snapshotPositions = new Set(next.rows.map(({ position }) => position));
      const ahead = previous.streamed ? previous.rows.filter(({ position }) =>
        checkpointOf(position) > next.checkpoint && !snapshotPositions.has(position),
      ) : [];
      const rows = ahead.length
        ? [...next.rows, ...ahead].sort((a, b) => compareEventCursors(b.position, a.position)).slice(0, Math.max(LIMIT, next.rows.length))
        : next.rows;
      return replaceEqualDeep(previous, {
        ...next,
        rows,
        streamed: previous.streamed,
        receivedAt: rows[0] && rows[0].position === previous.rows[0]?.position
          ? previous.receivedAt ?? next.receivedAt
          : next.receivedAt,
      });
    },
    refetchOnReconnect: false,
    refetchInterval: false,
    retryDelay: NEW_POSTS_MIN_GAP_MS,
  }, client);

  usePresaleMarketStream(presaleId, (frame) => {
    if (frame.type !== "presale_trade") return;
    client.setQueryData<TradeRead>(key, (previous) => {
      const known = previous?.rows ?? [];
      if ((previous && checkpointOf(frame.cursor) <= previous.checkpoint) || known.some((row) => row.position === frame.cursor)) return previous;
      const newer = !known[0] || compareEventCursors(frame.cursor, known[0].position) > 0;
      const streamed = previous?.streamed;
      return {
        rows: [streamedRow(frame, sale), ...known].sort((a, b) => compareEventCursors(b.position, a.position)).slice(0, Math.max(LIMIT, known.length)),
        clockMs: previous?.clockMs ?? 0,
        checkpoint: previous?.checkpoint ?? -1,
        receivedAt: newer ? performance.now() : previous?.receivedAt ?? null,
        streamed: !streamed || compareEventCursors(frame.cursor, streamed) > 0 ? frame.cursor : streamed,
      };
    });
  });

  useEffect(() => {
    let active = true;
    const gap = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), refresh);

    function refresh(hint?: FreshnessHint) {
      if (!active || document.hidden) return;
      const streamed = client.getQueryData<TradeRead>(key)?.streamed;
      if (hint?.trade && streamed && compareEventCursors(hint.trade.cursor, streamed) <= 0) return;
      const queued = pending.current?.trade;
      if (hint?.trade && (!queued || compareEventCursors(hint.trade.cursor, queued.cursor) > 0)) {
        pending.current = hint;
      }
      if (!gap.admit(hint)) return;
      const target = pending.current;
      const joined = client.getQueryState(key)?.fetchStatus === "fetching";
      void refetch({ cancelRefetch: false }).then(() => {
        const missed = pending.current;
        if (missed?.trade && (joined || missed !== target)) refresh(missed);
      });
    }

    // The query performs the first read. Leave room for any catch-up or trade signal.
    gap.admit();
    const source = presaleFreshness("presale-trades", NEW_POSTS_POLL_MS, presaleId, coinType);
    const off = source.subscribe(refresh);
    function clearHiddenCue() {
      if (!document.hidden) return;
      hiddenAt.current = Date.now();
      gap.cancel();
    }
    document.addEventListener("visibilitychange", clearHiddenCue);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", clearHiddenCue);
      off();
      gap.cancel();
    };
  }, [client, coinType, key, presaleId, refetch]);

  return useMemo(() => ({ data, isPending, refetch }), [data, isPending, refetch]);
}

const SaleTradeRead = createContext<ReturnType<typeof useSaleTradeFeed> | null>(null);

export function SaleTradeFeed({ sale, children }: Readonly<{ sale: SocialPresaleDetail["presale"]; children: ReactNode }>) {
  const read = useSaleTradeFeed(sale);
  const { data } = read;
  const chart = useMemo(() => {
    // The Last-trade pill skips dust, as the trades list does.
    const event = data?.rows.find((row) => !isHomeTradeUnderDollar(row.event.quote))?.event;
    const quote = event?.quote;
    return {
      // Coin activity can span venues and cannot price a candle for a specific pool.
      poolKey: null,
      placement: "headline" as const,
      trade: event ? {
        cursor: event.activity_id,
        timestampMs: event.occurred_at_ms,
        side: event.kind === "trade_buy" ? "buy" as const : "sell" as const,
        quoteAmount: BigInt(quote?.atoms ?? 0),
      } : null,
      receivedAt: data?.receivedAt ?? null,
      // Before the first trade, the sale's quote, so the headline reserves its full width. A trade with
      // an unknown quote shows only its direction.
      ...(event ? {
        decimals: quote?.quote_symbol ? quote.quote_decimals : null,
        symbol: quote?.quote_symbol ?? "",
        quoteType: quote?.quote_type,
      } : { decimals: sale.quote_decimals, symbol: sale.quote_symbol, quoteType: sale.quote_type }),
      tradeUsd: quote?.usd_complete ? quote.usd : null,
    };
  }, [data, sale.quote_decimals, sale.quote_symbol, sale.quote_type]);
  return <SaleTradeRead value={read}>
    <ChartTradeContext value={chart}>{children}</ChartTradeContext>
  </SaleTradeRead>;
}

export const SaleTrades = memo(function SaleTrades({ sale }: Readonly<{ sale: SocialPresaleDetail["presale"] }>) {
  const read = useContext(SaleTradeRead);
  const client = useAppQueryClient();
  const key = useMemo(() => queryKeys.home.presaleTrades(sale.presale_id), [sale.presale_id]);
  const tape = useMemo(() => createSaleTape(client, key), [client, key]);
  const { rows: recent, entering, leaving, slide } = useSyncExternalStore(tape.subscribe, tape.snapshot, tape.serverSnapshot);
  const { hold } = tape;
  const { explorer } = useDevicePrefs();
  const data = read?.data;
  const rows = recent.length ? recent : data?.rows.slice(0, LIMIT) ?? [];
  const visibility = useTradeVisibility(rows, data?.rows, (row) => isHomeTradeUnderDollar(row.event.quote));

  if (!read) return null;
  const { isPending, refetch } = read;
  if (isPending) return <TradeListSkeleton count={LIMIT} />;
  if (!data) return <EmptyState action={<Button onClick={() => void refetch()} size="sm">Try again</Button>} role="alert" title="Trades couldn’t load" />;
  if (!rows.length) return <EmptyState title="No trades in the last 24 hours" />;

  return <CompactTradeList visibility={visibility} entering={entering} leaving={leaving} slide={slide} hold={hold}>
    {(row, state) => <SaleTradeRow key={row.position} row={row} sale={sale} explorer={explorer} {...state} />}
  </CompactTradeList>;
});

const SaleTradeRow = memo(function SaleTradeRow({ row: { actor, event }, sale, explorer, ...state }: TradeRowState & Readonly<{
  row: TradeRead["rows"][number];
  sale: SocialPresaleDetail["presale"];
  explorer: SocialExplorer;
}>) {
  const onInspect = useTradeInspector();
  const quote = event.quote;
  const payment = quote?.quote_symbol && quote.quote_decimals !== null
    ? <ActivityAmount amount={BigInt(quote.atoms)} decimals={quote.quote_decimals} symbol={quote.quote_symbol} coinType={quote.quote_type} compact iconOnly onInspect={onInspect} />
    : quote?.usd != null ? usd(n(quote.usd), 2) : null;

  return <CompactTradeRow
    {...state}
    side={event.kind === "trade_buy" ? "buy" : "sell"}
    trader={actor.type === "address" ? <WalletAddress address={actor.address} label="trader address" onInspect={onInspect}>{actor.short}</WalletAddress> : actorName(actor)}
    profile={actor.type === "account" ? { callsign: actor.callsign, avatarUrl: actor.avatar_url } : null}
    timestampMs={event.occurred_at_ms}
    tokens={<ActivityAmount amount={event.tokens == null ? undefined : BigInt(event.tokens)} decimals={sale.sale_decimals ?? null} symbol={sale.symbol} coinType={sale.sale_token} iconUrl={sale.icon_url} compact iconOnly onInspect={onInspect} />}
    quote={payment}
    digest={event.digest}
    explorer={explorer}
  />;
});
