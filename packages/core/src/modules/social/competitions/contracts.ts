import { z } from "zod";
import type { CompetitionInput } from "./config.ts";
import type { SocialTradeCoin } from "../contracts/trades.ts";
export type { CompetitionInput } from "./config.ts";

export type Competition = CompetitionInput & Readonly<{ rules_version: 1 }>;
export type CompetitionMember = Readonly<{
  account_id: string;
  callsign: string;
  display_name: string | null;
  avatar_url: string | null;
  rank: number | null;
  volume_usd: string | null;
  swaps: number;
  unpriced_swaps: number;
  addresses: readonly string[];
}>;
export type CompetitionBoard = Readonly<{
  competition: Competition;
  members: readonly CompetitionMember[];
  /** How many members the board counts, on every page (the card's "Traders" tile). */
  members_total: number;
  page: number;
  has_more: boolean;
  as_of_ms: number;
  usd_basis: "input_value_at_submission";
}>;
export const COMPETITION_PAGE_SIZE = 25;
export const SOCIAL_COMPETITIONS_PATH = "/api/social/competitions";
export const SOCIAL_COMPETITIONS_ROUTE = `GET ${SOCIAL_COMPETITIONS_PATH}`;

export function socialCompetitionsPath(query: Readonly<{
  page: number;
  slug: string | null;
  period: CompetitionPeriod;
}> | Readonly<{ placement: "swap" }>): string {
  if ("placement" in query) {
    return `${SOCIAL_COMPETITIONS_PATH}?placement=${query.placement}`;
  }
  const params = new URLSearchParams({ page: String(query.page) });
  if (query.slug !== null) {
    params.set("slug", query.slug);
  } else {
    params.set("period", query.period);
  }
  return `${SOCIAL_COMPETITIONS_PATH}?${params}`;
}

/**
 * Redesign data gap 15: `GET /api/social/me/competitions/rank?slug=`, the
 * signed-in viewer's own row of a competition's board (its rank among the
 * public board, by the board's own rule), or null when the viewer has no
 * counted swap or is not on the public board (private, not sharing). Account
 * required, `private, no-store`, read on the primary as the board is.
 */
export const SOCIAL_COMPETITION_RANK_ROUTE = "GET /api/social/me/competitions/rank";
export const SOCIAL_COMPETITION_RANK_PATH = "/api/social/me/competitions/rank";
export type CompetitionViewerRank = Readonly<{
  competition: Competition;
  member: CompetitionMember | null;
  /** How many members the board counts (the card's "Traders" tile), whether or not the viewer is one. */
  members_total: number;
  as_of_ms: number;
  usd_basis: "input_value_at_submission";
}>;

/** `GET /api/social/me/competitions/rank` for one competition. */
export function socialCompetitionRankPath(slug: string): string {
  return `${SOCIAL_COMPETITION_RANK_PATH}?${new URLSearchParams({ slug }).toString()}`;
}
export type CompetitionPeriod = "current" | "past";

export type CompetitionDirectory = Readonly<{
  competitions: readonly Competition[];
  page: number;
  has_more: boolean;
  as_of_ms: number;
}>;

export type SwapCompetitions = Readonly<{
  competitions: readonly Competition[];
  coins: readonly SocialTradeCoin[];
  as_of_ms: number;
  next_change_at_ms: number | null;
}>;

/** The rank chip and viewer row consume this projection of the private rank response. */
export const competitionViewerSummarySchema = z.object({
  member: z.object({
    account_id: z.string(),
    callsign: z.string(),
    display_name: z.string().nullable(),
    avatar_url: z.string().nullable(),
    rank: z.number().int().nullable(),
    volume_usd: z.string().nullable(),
    swaps: z.number(),
    unpriced_swaps: z.number(),
    addresses: z.array(z.string()),
  }).nullable(),
  members_total: z.number(),
});
