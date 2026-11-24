import type { TradeQuoteRead } from "../trade/trade-quotes.ts";
import { socialTradeFeeFieldsSchema } from "@blast/core/web/contracts/trade-fee.ts";
import { responseDiagnostic } from "#web/lib/errors.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  socialTradeQuoteSchema,
  socialTradeResponseSchema,
  socialTradeBalanceFailureSchema,
  type TradeFeeRequired,
  type SocialTradeBalanceFailure,
  SOCIAL_TRADE_QUOTE_PATH,
  SOCIAL_TRADES_PATH,
  socialTradeSettlePath,
  type SocialTrade,
  type SocialTradeQuote,
  type SocialTradeQuoteRequest,
  type SocialTradeRequest,
} from "@blast/core/web/contracts/trades.ts";

import { callSocialApi, isRecord, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";
import { socialRequestAuth } from "../social-fetch";

/**
 * The trade surfaces' calls (social feed R3-30), through the shared session
 * helper (`callSocialApi`: the Privy token, or the wallet session cookie —
 * OA-16, so no Authorization header is ever built here). The quote route
 * takes a signed-out visitor too: `getAccessToken` may answer null.
 *
 * Consumers: the coins sheet's swap (R3-33), the sale page's commit bar once
 * the sale trades (R3-34), Blast mode's trade composer (R3-55); the trade
 * itself runs through `runTrade` (`trade-flow.ts`, R3-31).
 */

export function isTradeBalanceFailure(value: unknown): value is SocialTradeBalanceFailure {
  return socialTradeBalanceFailureSchema.safeParse(value).success;
}

/** Whether `value` is a well-formed quote answer (every field a surface renders). */
export function isSocialTradeQuote(value: unknown): value is SocialTradeQuote {
  return socialTradeQuoteSchema.safeParse(value).success;
}

/**
 * `POST /api/social/trades/quote`. A refusal is a published code (`rate_limited`
 * with its retry seconds, `invalid_request`, `service_unavailable`); a
 * quote without a route is still `ok`, with its `unavailable_reason`.
 */
export function requestTradeQuote(options: SocialApiOptions, body: SocialTradeQuoteRequest): Promise<ApiResult<SocialTradeQuote>> {
  return callSocialApi(options, SOCIAL_TRADE_QUOTE_PATH, { method: "POST", body }, socialTradeQuoteSchema);
}

/** Whether `value` is a well-formed trade answer (R3-31). */
export function isSocialTrade(value: unknown): value is SocialTrade {
  return socialTradeResponseSchema.safeParse(value).success;
}

/** `POST /api/social/trades`'s answer: the trade, or the fee prompt (`sponsorship_unavailable` with the fee), or a refusal. */
export type CreatedTrade =
  | Readonly<{ status: "ok"; trade: SocialTrade }>
  | TradeFeeRequired
  | Readonly<{ status: "refused"; code: string; retryAfterSeconds: number | null; httpStatus?: number; requestId?: string }>
  | Readonly<{ status: "error"; code?: string; httpStatus?: number; requestId?: string }>;

function feeRequiredOf(error: Record<string, unknown>): TradeFeeRequired | null {
  const parsed = socialTradeFeeFieldsSchema.safeParse(error);
  if (!parsed.success) return null;
  return { status: "fee_required", feeMist: parsed.data.fee_mist, ...(parsed.data.required_mist !== undefined ? { requiredMist: parsed.data.required_mist } : {}) };
}

/**
 * `POST /api/social/trades`. Through the shared session helper's own auth
 * (`socialRequestAuth`, OA-16) rather than `callSocialApi`, whose refusal
 * carries no field but the code: the fee prompt carries `fee_mist`.
 */
export async function createTrade(options: SocialApiOptions, body: SocialTradeRequest): Promise<CreatedTrade> {
  const auth = await socialRequestAuth(options.getAccessToken);
  if (!auth) return { status: "error", code: "authentication_unavailable" };
  let response: Response;
  try {
    response = await (options.fetch ?? gatedFetch)(SOCIAL_TRADES_PATH, {
      method: "POST",
      cache: "no-store",
      credentials: auth.credentials,
      signal: options.signal,
      headers: { ...auth.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { status: "error", code: "network_unavailable" };
  }
  const diagnostic = responseDiagnostic(response);
  const answer: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = socialTradeResponseSchema.safeParse(answer);
    return parsed.success ? { status: "ok", trade: parsed.data } : { status: "error", code: "invalid_response", ...diagnostic };
  }
  const error = isRecord(answer) && isRecord(answer.error) ? answer.error : null;
  if (!error || typeof error.code !== "string") return { status: "error", code: "invalid_response", ...diagnostic };
  if (error.code === "sponsorship_unavailable") return feeRequiredOf(error) ?? { status: "error", code: "invalid_response", ...diagnostic };
  const retryAfter = Number(response.headers.get("retry-after"));
  return { status: "refused", code: error.code, ...diagnostic, retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : null };
}

/** `POST /api/social/trades/{trade_id}/settle`: the trade as the chain now shows it. */
export function settleTrade(options: SocialApiOptions, tradeId: string): Promise<ApiResult<SocialTrade>> {
  return callSocialApi(options, socialTradeSettlePath(tradeId), { method: "POST" }, socialTradeResponseSchema);
}

export type TradeQuoteRequester = (body: SocialTradeQuoteRequest, signal: AbortSignal) => Promise<ApiResult<SocialTradeQuote>>;

export function tradeQuoteReader(request: TradeQuoteRequester): TradeQuoteRead {
  return async (body, signal) => {
    const answer = await request(body, signal ?? new AbortController().signal);
    return answer.status === "ok" ? { status: "ok", quote: answer.body } : answer;
  };
}
