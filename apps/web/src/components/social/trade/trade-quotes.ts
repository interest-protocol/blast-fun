import type { ErrorDiagnostic } from "#web/lib/errors.ts";
import { SOCIAL_TRADE_QUOTE_BUSY_RETRY_SECONDS, type SocialTradeQuote, type SocialTradeQuoteRequest } from "@blast/core/web/contracts/trades.ts";

import { requoteInMs } from "../trades/trade-quote-view";

/**
 * The rules of a trade surface's quote (R3-30's `POST
 * /api/social/trades/quote`), shared by every trade surface — Blast mode's
 * composer (R3-55), the coins sheet's swap (R3-33), the sale page's bar
 * (R3-34) — so each asks the same way. The engine that asks is one TanStack
 * Query read (`trade-quote-query.ts`, OA-38); this module is its pure part:
 * what a request's identity is, and when what is on screen is asked again.
 *
 * - **debounced**: a new amount is asked `debounceMs` after it stops changing
 *   (`now` skips the wait: a preset, a mode, a composer arriving);
 * - **one in flight, the last one wins**: a new question cancels the read of
 *   the one before (its abort signal), so an old answer never lands on a
 *   newer question;
 * - **kept fresh**: an offered quote is asked again `REQUOTE_MARGIN_MS` before
 *   its `quote_id` expires (20 s), never while a trade runs; an estimate
 *   priced from the browser's route (`routed`) is asked again every
 *   `shownRefreshMs` where the surface wants it (a server answer that is only
 *   shown is not: no idle server re-quote); `rate_limited` after its
 *   `Retry-After`; another failure after `retryMs`, where the surface wants it.
 */

export const TRADE_QUOTE_DEBOUNCE_MS = 250;
/** An estimate priced from the browser's route is asked again this often while it is on screen (the swap and Blast mode's composer). */
export const TRADE_QUOTE_SHOWN_REFRESH_MS = 20_000;
/** A failed or refused quote is asked again after this long, or its `Retry-After` (Blast mode's composer). */
export const TRADE_QUOTE_RETRY_MS = 5_000;
/** `rate_limited` without a `Retry-After` is asked again after this long. */
export const TRADE_QUOTE_RATE_LIMITED_MS = 5_000;

export type TradeQuoteAnswer = ErrorDiagnostic & (
  /** `routed`: priced in the browser from Cetus's route (`trade-estimate.ts`), so refreshing it costs our server nothing. */
  | Readonly<{ status: "ok"; quote: SocialTradeQuote; routed?: boolean }>
  | Readonly<{ status: "refused"; code: string; retryAfterSeconds: number | null }>
  | Readonly<{ status: "error" }>);

/** One quote request; `signal` aborts it once nobody wants its answer. */
export type TradeQuoteRead = (request: SocialTradeQuoteRequest, signal?: AbortSignal) => Promise<TradeQuoteAnswer>;

export type TradeQuoteSnapshot = Readonly<{
  key: string | null;
  quote: SocialTradeQuote | null;
  shown: SocialTradeQuote | null;
  loading: boolean;
  error: Readonly<{ code: string | null; requestId?: string; httpStatus?: number | null; retryAfterSeconds?: number | null }> | null;
}>;

export const IDLE_TRADE_QUOTE: TradeQuoteSnapshot = { key: null, quote: null, shown: null, loading: false, error: null };

export function tradeRequestKey(request: SocialTradeQuoteRequest | null): string | null {
  return request === null ? null : tradeQuoteKey(request);
}

/** The request's identity: the pair, the side, the amount and the slippage (and who asks, `scope`). */
export function tradeQuoteKey(request: SocialTradeQuoteRequest, scope = ""): string {
  return [scope, request.side, request.in_coin, request.out_coin, request.amount_in ?? "", request.amount_out ?? "", request.slippage_bps ?? ""].join("|");
}

/** How a surface re-asks. */
export type TradeQuotePolicy = Readonly<{
  /** The pause in typing before a question is asked. */
  debounceMs: number;
  /** A shown-only quote is asked again after this long; null: never. */
  shownRefreshMs: number | null;
  /** A failure other than `rate_limited` is asked again after this long; null: never. */
  retryMs: number | null;
  /** `rate_limited` without a `Retry-After` is asked again after this long. */
  rateLimitedMs: number;
}>;

/** The coins sheet's swap (R3-33): only an offered quote is kept fresh; transient pool, outage and rate-limit refusals recover automatically. */
export const DEFAULT_TRADE_QUOTE_POLICY: TradeQuotePolicy = {
  debounceMs: TRADE_QUOTE_DEBOUNCE_MS,
  shownRefreshMs: null,
  retryMs: null,
  rateLimitedMs: TRADE_QUOTE_RATE_LIMITED_MS,
};

/** Why the last ask failed: a published refusal's code (and its `Retry-After`), or null for anything else. */
export type TradeQuoteFailure = Readonly<{ code: string | null; retryAfterSeconds: number | null; requestId?: string; httpStatus?: number | null }>;

function quoteBusyRetryMs(seconds: number | null): number {
  return (seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : SOCIAL_TRADE_QUOTE_BUSY_RETRY_SECONDS) * 1_000;
}

/**
 * When what is on screen is asked again, from `nowMs`: an offered quote 2 s
 * before it expires (at least 1 s on), a browser-routed estimate after `shownRefreshMs`
 * (a coin not trading yet, or a pool out for a moment, is retried until it is; `no_pool` is not: nothing routes it, so
 * it waits for another amount or pair), `rate_limited` after its `Retry-After`,
 * `pool_unavailable` and `service_unavailable` after their `Retry-After` or 5 s on every surface, another failure after
 * its `Retry-After` or `retryMs` where the surface re-asks failures. Null:
 * not until the question changes.
 */
export function tradeQuoteDueInMs(
  state: Readonly<{ quote: SocialTradeQuote | null; failure: TradeQuoteFailure | null; routed?: boolean }>,
  nowMs: number,
  policy: TradeQuotePolicy,
): number | null {
  if (state.failure !== null) {
    const after = state.failure.retryAfterSeconds === null ? null : state.failure.retryAfterSeconds * 1_000;
    if (state.failure.code === "quote_busy") return quoteBusyRetryMs(state.failure.retryAfterSeconds);
    if (state.failure.code === "rate_limited") return after ?? policy.rateLimitedMs;
    // A moved pool or an outage passes: ask again on its own, so no surface needs a Retry button for it.
    if (state.failure.code === "pool_unavailable" || state.failure.code === "service_unavailable") return after ?? TRADE_QUOTE_RETRY_MS;
    return policy.retryMs === null ? null : (after ?? policy.retryMs);
  }
  if (state.quote === null) return null;
  return requoteInMs(state.quote, nowMs) ?? (["not_tradable", "pool_unavailable"].includes(state.quote.unavailable_reason ?? "") ? TRADE_QUOTE_RETRY_MS : state.routed === true ? policy.shownRefreshMs : null);
}
