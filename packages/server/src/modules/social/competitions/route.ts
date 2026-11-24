import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { competitionSlug } from "@blast/core/modules/social/competitions/config.ts";
import { SOCIAL_COMPETITION_RANK_ROUTE, SOCIAL_COMPETITIONS_ROUTE, type CompetitionPeriod } from "@blast/core/modules/social/competitions/contracts.ts";
import {
  findCompetition,
  listCompetitions,
  readCompetitionBoard,
  readCompetitionViewerRank,
  readSwapCompetitions,
} from "./repository.ts";

export function competitionPage(params: URLSearchParams): number {
  return socialParameter(z.string().regex(/^[1-9][0-9]{0,4}$/).transform(Number), socialSingle(params, "page") ?? "1", "page");
}

export function competitionPeriod(params: URLSearchParams): CompetitionPeriod {
  return socialParameter(z.enum(["current", "past"]), socialSingle(params, "period") ?? "current", "period");
}

export function createCompetitionRoutes(
  deps: Readonly<{
    kit: SocialRouteKit;
    database: () => ReadableDatabase;
    now?: () => number;
  }>,
) {
  return deps.kit.route(
    {
      name: SOCIAL_COMPETITIONS_ROUTE,
      auth: "none",
      bucket: "social_read",
      cache: "private",
    },
    async (ctx) => {
      const params = new URL(ctx.request.url).searchParams;
      if (params.has("placement")) {
        socialParameter(z.object({
          placement: z.tuple([z.literal("swap")]),
          slug: z.array(z.string()).length(0),
          page: z.array(z.string()).length(0),
          period: z.array(z.string()).length(0),
        }), {
          placement: params.getAll("placement"), slug: params.getAll("slug"),
          page: params.getAll("page"), period: params.getAll("period"),
        }, "placement");
        return ctx.json(await readSwapCompetitions(deps.database(), (deps.now ?? Date.now)()));
      }
      const page = competitionPage(params);
      if (!params.has("slug"))
        return ctx.json(
          await listCompetitions(
            deps.database(),
            page,
            competitionPeriod(params),
            (deps.now ?? Date.now)(),
          ),
        );
      const slug = socialParameter(competitionSlug, socialSingle(params, "slug"), "slug");
      const competition = await findCompetition(deps.database(), slug);
      if (!competition) throw new SocialRouteError("not_found");
      return ctx.json(
        await readCompetitionBoard(deps.database(), competition, page, (deps.now ?? Date.now)()),
      );
    },
  );
}
import { z } from "zod";

import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";

/**
 * Redesign gap 15: `GET /api/social/me/competitions/rank?slug=`, the
 * signed-in viewer's own row of the competition's board (contract in
 * `competitions/contracts.ts`). Account required, `private, no-store`.
 */
export function createCompetitionRankRoute(
  deps: Readonly<{
    kit: SocialRouteKit;
    database: () => ReadableDatabase;
    now?: () => number;
  }>,
) {
  return deps.kit.route(
    { name: SOCIAL_COMPETITION_RANK_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
    async (ctx) => {
      const slug = socialParameter(competitionSlug, socialSingle(new URL(ctx.request.url).searchParams, "slug"), "slug");
      const competition = await findCompetition(deps.database(), slug);
      if (!competition) throw new SocialRouteError("not_found");
      return ctx.json(await readCompetitionViewerRank(deps.database(), competition, ctx.account!.account_id, (deps.now ?? Date.now)()));
    },
  );
}
