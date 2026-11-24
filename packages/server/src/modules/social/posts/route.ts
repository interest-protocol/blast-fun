import { z } from "zod";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { REACTION_KEY_PATTERN, type SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_ITEM_ROUTE, SOCIAL_REACTION_ROUTE } from "@blast/core/modules/social/contracts/item-routes.ts";
import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import { SOCIAL_ITEM_PATH, SOCIAL_REACTION_PATH } from "@blast/core/modules/backend-api/private/social-read-contracts.ts";
import { SOCIAL_ENTRY_ID_PATTERN } from "@blast/core/modules/social/contracts/viewer-state.ts";
import { isVisible } from "@blast/server/modules/social/read-model/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { readPost } from "@blast/server/modules/social/posts/read.ts";

export type SocialPostRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production, for the public item read. Resolved per request. */
  database: () => ReadableDatabase;
  /** The tuning values of this request (`getSocialConfig`): thresholds and the reaction keys. */
  config: () => Promise<SocialConfig>;
  now?: () => number;
}>;

/**
 * `{entry_id}` alone, or `{entry_id}/reactions/{reaction}`. A malformed
 * entry id is `invalid_parameter` naming `entry_id`; a malformed reaction
 * key names `reaction`.
 */
export function itemPathParameters(request: Request, withReaction: boolean): Readonly<{ entryId: string; reaction: string | null }> {
  const pathname = new URL(request.url).pathname;
  const params = withReaction ? routeParams(SOCIAL_REACTION_PATH, pathname) : routeParams(SOCIAL_ITEM_PATH, pathname);
  const parsedEntryId = z.string().regex(SOCIAL_ENTRY_ID_PATTERN).safeParse(params?.entry_id);
  if (!parsedEntryId.success) {
    throw new SocialRouteError("invalid_parameter", { extra: { parameter: "entry_id" } });
  }
  if (!withReaction) return { entryId: parsedEntryId.data, reaction: null };
  const reaction = params && "reaction" in params ? params.reaction : null;
  const parsedReaction = z.string().regex(REACTION_KEY_PATTERN).safeParse(reaction);
  if (!parsedReaction.success) {
    throw new SocialRouteError("invalid_parameter", { extra: { parameter: "reaction" } });
  }
  return { entryId: parsedEntryId.data, reaction: parsedReaction.data };
}

/** A `204` with the kit's headers for a `no-store` route. */
function noContent(context: SocialRequestContext): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-ID": context.requestId } });
}

/**
 * The item routes (contract in `contracts/item-routes.ts`):
 *
 * - `item.GET`: the public item, `auth: "none"`, bucket `social_read`,
 *   `cache: "public"`, read only through `database()` (the replica).
 * - `reaction.PUT` / `reaction.DELETE` (T-010): account required, bucket
 *   `social_reaction`. After the kit: the path (`invalid_parameter`), the
 *   configured keys (`invalid_reaction`), then one primary transaction that
 *   checks visibility (`not_found`) and writes the one row
 *   `(entry_id, account_id, reaction)` idempotently: `ON CONFLICT DO NOTHING`
 *   adds it, `DELETE` removes it, so a retry changes nothing. Both are single
 *   statements on their primary key: READ COMMITTED is enough.
 */
export function createSocialPostRoutes(dependencies: SocialPostRouteDependencies) {
  const { kit, database, config } = dependencies;
  const now = dependencies.now ?? Date.now;
  const reactionSpec = (method: "PUT" | "DELETE") =>
    ({ name: `${method} ${SOCIAL_REACTION_ROUTE}`, auth: "account", account: "required", bucket: "social_reaction" }) as const;

  async function react(context: SocialRequestContext, add: boolean): Promise<Response> {
    const { entryId, reaction } = itemPathParameters(context.request, true);
    const values = await config();
    if (!values.reactions.includes(reaction!)) throw new SocialRouteError("invalid_reaction");
    const accountId = context.account!.account_id;
    await context.transaction(async (social) => {
      const visible = await isVisible(social, entryId, { bigCommitUsd: values.big_commit_usd, bigTradeUsd: values.big_trade_usd });
      if (!visible) throw new SocialRouteError("not_found");
      if (add) {
        await social.write(
          "social_reactions",
          `INSERT INTO social_reactions (entry_id, account_id, reaction) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [entryId, accountId, reaction],
        );
      } else {
        await social.write(
          "social_reactions",
          "DELETE FROM social_reactions WHERE entry_id = $1 AND account_id = $2 AND reaction = $3",
          [entryId, accountId, reaction],
        );
      }
    }, { label: "social.reaction" });
    return noContent(context);
  }

  return Object.freeze({
    item: Object.freeze({
      GET: kit.route(
        { name: SOCIAL_ITEM_ROUTE, auth: "none", bucket: "social_read", cache: "public" },
        async (context) => {
          const { entryId } = itemPathParameters(context.request, false);
          const post = await readPost(database(), entryId, { config: await config(), nowMs: now(), hiddenKinds: context.hiddenKinds });
          if (!post) throw new SocialRouteError("not_found");
          return context.json(post);
        },
      ),
    }),
    reaction: Object.freeze({
      PUT: kit.route(reactionSpec("PUT"), (context) => react(context, true)),
      DELETE: kit.route(reactionSpec("DELETE"), (context) => react(context, false)),
    }),
  });
}

export type SocialPostRoutes = ReturnType<typeof createSocialPostRoutes>;
