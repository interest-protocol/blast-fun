import { callSocialApi } from "#web/components/social/social-api.ts";
import {
  portfolioCoinPageRowSchema,
  portfolioCoinPageSchema,
  socialPortfolioSchema,
  SOCIAL_PORTFOLIO_COINS_PATH,
  SOCIAL_PORTFOLIO_PATH,
  type PortfolioCoinPage,
  type SocialPortfolio,
} from "@blast/core/web/contracts/portfolio.ts";

import type { AccessTokenSource } from "./viewer-state-client";

export type PortfolioReadResult =
  | Readonly<{ status: "ready"; portfolio: SocialPortfolio }>
  | Readonly<{ status: "refused"; code: string; httpStatus?: number; retryAfterSeconds?: number | null; requestId?: string }>
  | Readonly<{ status: "error"; code?: string; httpStatus?: number; requestId?: string }>;

export function isCoin(value: unknown): boolean {
  const parsed = portfolioCoinPageRowSchema.safeParse(value);
  return parsed.success && parsed.data.balance !== "0";
}

export function isSocialPortfolio(value: unknown): value is SocialPortfolio {
  return socialPortfolioSchema.safeParse(value).success;
}

/**
 * `GET /api/social/me/portfolio` with the viewer's Privy access token: the
 * caller's own portfolio, never cached. No token, or a published refusal, is
 * `refused` with its code; a network failure or a malformed answer is
 * `error`.
 */
export async function fetchPortfolio(
  input: Readonly<{ getAccessToken: AccessTokenSource; summary?: boolean; wallet?: string; signal?: AbortSignal; fetch?: typeof globalThis.fetch }>,
): Promise<PortfolioReadResult> {
  const params = new URLSearchParams();
  if (input.summary) params.set("view", "summary");
  if (input.wallet) params.set("wallet", input.wallet);
  const query = params.toString();
  const result = await callSocialApi(input, query ? `${SOCIAL_PORTFOLIO_PATH}?${query}` : SOCIAL_PORTFOLIO_PATH, { method: "GET" }, socialPortfolioSchema);
  return result.status === "ok" ? { status: "ready", portfolio: result.body } : result;
}

export function isPortfolioCoinPage(value: unknown): value is PortfolioCoinPage {
  return portfolioCoinPageSchema.safeParse(value).success;
}

export async function fetchPortfolioCoins(input: Readonly<{ getAccessToken: AccessTokenSource; page: number; search: string; hideSmall?: boolean; wallet?: string; signal?: AbortSignal }>) {
  const params = new URLSearchParams({ page: String(input.page), q: input.search, hide_small: String(input.hideSmall ?? false) });
  if (input.wallet) params.set("wallet", input.wallet);
  return callSocialApi(input, `${SOCIAL_PORTFOLIO_COINS_PATH}?${params}`, { method: "GET" }, portfolioCoinPageSchema);
}
