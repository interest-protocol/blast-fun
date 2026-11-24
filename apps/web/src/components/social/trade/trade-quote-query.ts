"use client";

import { PublicError } from "#web/lib/errors.ts";

import { keepPreviousData, useQuery, type Query, type UseQueryResult, type QueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { QueryRefusal, QueryTransientError } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialTradeQuote, SocialTradeQuoteRequest } from "@blast/core/web/contracts/trades.ts";

import { useSocialViewer } from "../SignInGate";
import { DEFAULT_TRADE_QUOTE_POLICY, tradeQuoteDueInMs, tradeQuoteKey, type TradeQuoteFailure, type TradeQuotePolicy, type TradeQuoteRead, type TradeQuoteSnapshot } from "./trade-quotes";

/**
 * The one trade-quote engine (OA-38; the rules are `trade-quotes.ts`): a
 * TanStack Query read keyed by the full request **and the viewer**
 * (`queryKeys.quotes.swap`), so no quote is ever reused for someone else.
 *
 * - The pause: the query is `enabled` once the request has stood still for
 *   the policy's `debounceMs` (`now` asks at once).
 * - One in flight: a new request moves the query to a new key; the read it
 *   leaves is cancelled through the query's abort signal, so its answer never
 *   lands.
 * - Kept fresh: the query is fetched again when its answer (or its failure)
 *   is due (`tradeQuoteDueInMs`: 2 s before an offered quote expires,
 *   `Retry-After` on `rate_limited`, …), never while `held` (a trade is
 *   running) or while the tab is hidden. `staleTime` is the same moment, so a surface that comes back
 *   inside it, or typing back to an amount, reads the cache.
 * - At expiry the surface draws again, so its button reads the quote as stale.
 *
 * The re-ask is a timer on the answer's own due time, not `refetchInterval`:
 * TanStack recomputes an interval on every render, and with the 1 s floor
 * near expiry a surface that draws every second would push it back forever.
 * Every wait this hook owns (the pause, the re-ask, the expiry draw) runs on
 * `timers`: Blast mode passes its task registry, so leaving the mode stops
 * them, and a test passes its hand clock.
 */

export type TradeQuoteTimers = Readonly<{ after: (run: () => void, ms: number) => unknown; clear: (handle: unknown) => void }>;

const SYSTEM_TIMERS: TradeQuoteTimers = {
  after: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type TradeQuoteOptions = Readonly<{
  read: TradeQuoteRead;
  active?: boolean;
  /** What is typed now; null: nothing to ask. */
  request: SocialTradeQuoteRequest | null;
  /** Who asks, as the surface names it (part of the snapshot's `key`). */
  scope?: string;
  /** Ask this change at once, without the pause. */
  now?: boolean;
  /** A trade is running: nothing replaces the quote it used. */
  held?: boolean;
  /** The surface's timers, fixed for its life; the system's by default. */
  timers?: TradeQuoteTimers;
  policy?: Partial<TradeQuotePolicy>;
  /**
   * Other questions the surface may ask next (the amount presets), read into
   * the cache once while it is active, so picking one shows its answer at once.
   * Each is read only when it has no fresh answer; nothing is read while
   * `held` or while the tab is hidden.
   */
  prefetch?: readonly SocialTradeQuoteRequest[];
  /**
   * How `prefetch` is read (by default `read`): the surfaces read ahead from the browser's route only, never the
   * server. A read ahead that fails leaves nothing cached, so picking that preset asks it with `read`.
   */
  prefetchRead?: TradeQuoteRead;
}>;

export type TradeQuoteState = TradeQuoteSnapshot &
  Readonly<{
    /** Clock captured on mount, response arrival, expiry and tab return, for signature eligibility. */
    nowMs: number;
    /** Ask again now. `cancel`: replace a read already out (else join it). */
    refresh: (options?: Readonly<{ cancel?: boolean }>) => void;
    /** A confirmed trade consumed this quote; the next trade needs a fresh one. */
    invalidate: () => void;
    /** Puts a sealed quote on screen in place of the answer for this question (a press stopped on it, to be read first). */
    show: (quote: SocialTradeQuote) => void;
  }>;

type Answered = Readonly<{ quote: SocialTradeQuote; at: number; routed: boolean }>;

/** One spread per overload answer, retained with that error in the viewer’s query cache. */
class QuoteBusyRefusal extends QueryRefusal {
  readonly retryJitterMs = Math.random() * 1_000;
}

const failureOf = (error: unknown): TradeQuoteFailure =>
  error instanceof PublicError ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds, ...(error.requestId ? { requestId: error.requestId } : {}), ...(error.httpStatus !== null ? { httpStatus: error.httpStatus } : {}) } : { code: null, retryAfterSeconds: null };

/** The cache key: the request, who asks and the viewer, as plain values (equal requests are one entry). */
function cacheKey(request: SocialTradeQuoteRequest | null, scope: string, viewer: string | null) {
  if (request === null) return queryKeys.quotes.swap({ viewer, none: true });
  return queryKeys.quotes.swap({
    viewer,
    scope,
    side: request.side,
    in_coin: request.in_coin,
    out_coin: request.out_coin,
    amount_in: request.amount_in ?? null,
    amount_out: request.amount_out ?? null,
    slippage_bps: request.slippage_bps ?? null,
  });
}

export function useTradeQuoteQuery(options: TradeQuoteOptions): TradeQuoteState {
  const client = useAppQueryClient();
  const viewer = useSocialViewer();
  const viewerKey = viewer.signedIn ? (viewer.callsign ?? "") : null;
  const policy: TradeQuotePolicy = { ...DEFAULT_TRADE_QUOTE_POLICY, ...options.policy };
  const active = options.active !== false;
  const mountId = useId();
  const [visibility, setVisibility] = useState({ active, generation: 0 });
  if (visibility.active !== active) setVisibility({ active, generation: visibility.generation + (active ? 1 : 0) });
  // A returning ticket must not reuse a quote retained by another mounted ticket.
  const scope = (options.scope ?? "") + (visibility.generation ? `|return:${mountId}:${visibility.generation}` : "");
  const request = active ? options.request : null;
  const { read } = options;
  const held = options.held === true;
  const key = request === null ? null : tradeQuoteKey(request, scope);
  // Read only from effects: the surface's timers are fixed for its life (Blast mode's registry).
  const timers = useRef(options.timers ?? SYSTEM_TIMERS);

  const quoteRead = quoteQueryOptions(request, read, scope, viewerKey, policy);

  const asked = useSettledTradeRequest(client, quoteRead, key, options.now === true, policy.debounceMs, timers);
  const prefetchRead = options.prefetchRead ?? read;
  useTradeQuotePrefetch(client, active && !held ? (options.prefetch ?? []) : [], (ahead) => quoteQueryOptions(ahead, prefetchRead, scope, viewerKey, policy));

  const query = useQuery<Answered, Error, Answered, readonly unknown[]>(
    {
      ...quoteRead,
      // A read that failed is not read again because the query was enabled or mounted (the pause's own read
      // may just have failed, and `settled` enables the query a render later). A failed query has no data, so
      // TanStack counts it stale whatever `staleTime` says, and enabling it (`shouldFetchOptionally`) would read
      // again: one question, two reads. So a failed question is not enabled; the failure's due timer, the
      // pause (`prefetchQuery`) and `refresh` ask it again (`refetch` reads a disabled query too).
      enabled: (cached: Query<Answered, Error, Answered, readonly unknown[]>) => asked && cached.state.status !== "error",
      // Focus and reconnect ask nothing: the answer's own due time does.
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // While a new request is asked, the last answer stays readable as `shown` (never as the new request's).
      placeholderData: keepPreviousData,
    },
    client,
  );

  const { answered, failure, ...snapshot } = quoteQuerySnapshot(query, key, asked);
  const liveness = useTradeQuoteLiveness(query, answered, failure, JSON.stringify(quoteRead.queryKey), asked, held, policy, timers);
  const { refetch } = query;
  return {
    ...snapshot,
    ...liveness,
    invalidate: () => { void client.invalidateQueries({ queryKey: quoteRead.queryKey, exact: true, refetchType: "none" }); },
    show: (quote) => { if (key !== null) client.setQueryData<Answered>(quoteRead.queryKey, { quote, at: Date.now(), routed: false }); },
    refresh: (refreshOptions = {}) => {
      if (key !== null) void refetch({ cancelRefetch: refreshOptions.cancel === true });
    },
  };
}

function quoteQueryOptions(request: SocialTradeQuoteRequest | null, read: TradeQuoteRead, scope: string, viewerKey: string | null, policy: TradeQuotePolicy) {
  const quoteRead = {
    queryKey: cacheKey(request, scope, viewerKey),
    queryFn: async ({ signal }: Readonly<{ signal: AbortSignal }>): Promise<Answered> => {
      if (request === null) throw new QueryTransientError("Nothing to quote.");
      const at = Date.now();
      const answer = await read(request, signal);
      if (answer.status === "ok") return { quote: answer.quote, at, routed: answer.routed === true };
      if (answer.status === "refused") {
        const Refusal = answer.code === "quote_busy" ? QuoteBusyRefusal : QueryRefusal;
        throw new Refusal(answer.code, { retryAfterSeconds: answer.retryAfterSeconds, requestId: answer.requestId, httpStatus: answer.httpStatus });
      }
      throw new QueryTransientError("The quote could not be read. Try again.", answer.httpStatus ?? null, answer.requestId, answer.code ?? "network_unavailable");
    },
    // Fresh until it is due again, counted from when it was answered.
    staleTime: (cached: Query<Answered, Error, Answered, readonly unknown[]>) => {
      const quote = cached.state.data?.quote ?? null;
      if (quote === null) return 0;
      return tradeQuoteDueInMs({ quote, failure: null, routed: cached.state.data?.routed }, cached.state.dataUpdatedAt, policy) ?? Number.POSITIVE_INFINITY;
    },
    retry: false,
  } as const;
  return quoteRead;
}

function useTradeQuoteLiveness(
  query: UseQueryResult<Answered, Error>, answered: Answered | undefined, failure: TradeQuoteFailure | null, queryIdentity: string, asked: boolean, held: boolean, policy: TradeQuotePolicy, timers: RefObject<TradeQuoteTimers>,
) {
  const { refetch, isFetching, dataUpdatedAt, errorUpdatedAt, error } = query;

  // Asked again when what is on screen is due (not while a trade runs, nor while a read is out).
  const dueQuote = answered?.quote ?? null;
  const dueFailure = failure;
  const routed = answered?.routed === true;
  const latest = useRef({ quote: dueQuote, failure: dueFailure, routed, policy });
  const [clockMs, setClockMs] = useState(Date.now);
  useEffect(() => {
    latest.current = { quote: dueQuote, failure: dueFailure, routed, policy };
  });
  useEffect(() => {
    const clock = timers.current;
    let handle: unknown;
    const cancel = () => {
      if (handle !== undefined) clock.clear(handle);
      handle = undefined;
    };
    const schedule = () => {
      cancel();
      if (!asked || held || isFetching || document.visibilityState === "hidden") return;
      const state = latest.current;
      // Retry-After and shown-only refresh keep their original deadline across tab suspension.
      const answeredAt = state.failure === null ? dataUpdatedAt : errorUpdatedAt;
      const due = tradeQuoteDueInMs(state, answeredAt, state.policy);
      if (due === null) return;
      const busy = error instanceof QuoteBusyRefusal;
      const deadline = answeredAt + due + (busy ? error.retryJitterMs : 0);
      const retry = () => {
        handle = undefined;
        if (document.visibilityState === "hidden") return;
        // A wall-clock adjustment must not send overloaded work before its minimum wait.
        if (busy && Date.now() < deadline) {
          handle = clock.after(retry, deadline - Date.now());
          return;
        }
        void refetch();
      };
      handle = clock.after(retry, Math.max(0, deadline - Date.now()));
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== "hidden") {
        setClockMs(Date.now());
      }
      schedule();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    schedule();
    return () => {
      cancel();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [asked, held, isFetching, queryIdentity, dataUpdatedAt, errorUpdatedAt, error, refetch, timers]);

  // The moment an offered quote expires, the surface draws again (its button reads the quote as stale).
  const expiresAt = answered?.quote.expires_at_ms ?? null;
  useEffect(() => {
    if (expiresAt === null) return undefined;
    const clock = timers.current;
    let handle: unknown;
    const expire = () => {
      const nowMs = Date.now();
      // Timers can fire before the wall clock reaches the deadline.
      if (nowMs < expiresAt) {
        handle = clock.after(expire, expiresAt - nowMs);
        return;
      }
      setClockMs(nowMs);
    };
    handle = clock.after(expire, Math.max(0, expiresAt - Date.now()));
    return () => clock.clear(handle);
  }, [expiresAt, timers]);
  return { nowMs: Math.max(clockMs, dataUpdatedAt) };
}

function useTradeQuotePrefetch(client: QueryClient, requests: readonly SocialTradeQuoteRequest[], options: (request: SocialTradeQuoteRequest) => ReturnType<typeof quoteQueryOptions>) {
  const latest = useRef({ requests, options });
  useEffect(() => {
    latest.current = { requests, options };
  });
  // The questions' identity (and who asks): a render that asks the same ones reads nothing more.
  const identity = JSON.stringify(requests.map((request) => options(request).queryKey));
  useEffect(() => {
    if (document.visibilityState === "hidden") return;
    const { requests: ahead, options: read } = latest.current;
    for (const request of ahead) {
      const options = read(request);
      void client.prefetchQuery(options).then(() => {
        const cached = client.getQueryCache().find({ queryKey: options.queryKey, exact: true });
        if (cached?.state.status === "error" && cached.state.data === undefined && cached.getObserversCount() === 0) client.removeQueries({ queryKey: options.queryKey, exact: true });
      });
    }
  }, [client, identity]);
}

function useSettledTradeRequest(client: QueryClient, quoteRead: ReturnType<typeof quoteQueryOptions>, key: string | null, immediate: boolean, debounceMs: number, timers: RefObject<TradeQuoteTimers>) {
  // The pause: a request is asked once it has stood still for `debounceMs` — the read leaves from the timer
  // itself, as the surface's own engines did (`prefetchQuery`: nothing when a fresh answer is cached, the read
  // in flight when one is out); `settled` then enables the query, which joins that read.
  const askSettled = useRef<() => void>(() => undefined);
  useEffect(() => {
    askSettled.current = () => void client.prefetchQuery(quoteRead);
  });
  const [settled, setSettled] = useState<string | null>(null);
  // A question that changes (even back to one asked before) waits for its own pause, unless its answer is
  // already here and fresh (a preset read ahead): nothing would be asked, so it shows at once.
  const [current, setCurrent] = useState(key);
  if (current !== key) {
    setCurrent(key);
    setSettled(null);
  }
  const cached = key === null ? undefined : client.getQueryCache().find<Answered, Error, Answered>({ queryKey: quoteRead.queryKey, exact: true });
  const fresh = cached?.state.status === "success" && !cached.isStaleByTime(quoteRead.staleTime(cached));
  const asked = key !== null && (immediate || fresh || settled === key);
  useEffect(() => {
    if (key === null || key === settled) return undefined;
    // Asked at once (`now`): the read leaves here, before the query is enabled, which joins it. A question that
    // failed before is read again too (a failed query is never enabled, so enabling it would not ask).
    if (asked) askSettled.current();
    const clock = timers.current;
    const handle = clock.after(() => {
      setSettled(key);
      // Asked already (`now`): the query has it; asking again here would re-read a failed answer early.
      if (!asked) askSettled.current();
    }, debounceMs);
    return () => clock.clear(handle);
  }, [key, settled, debounceMs, asked, timers]);

  return asked;
}

function quoteQuerySnapshot(query: UseQueryResult<Answered, Error>, key: string | null, asked: boolean) {
  const answered = query.isPlaceholderData ? undefined : query.data;
  const failure = key !== null && !query.isPlaceholderData && query.status === "error" ? failureOf(query.error) : null;
  return {
    answered, key, quote: answered?.quote ?? null,
    loading: key !== null && (query.isFetching || !asked),
    shown: query.data?.quote ?? null, failure, error: failure,
  };
}
