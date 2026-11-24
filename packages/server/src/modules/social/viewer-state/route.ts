import { readViewerState } from "./store.ts";
import {
  SOCIAL_VIEWER_STATE_ROUTE,
  socialViewerStateRequestSchema,
  type SocialViewerBackers,
  type SocialViewerStateResponse,
} from "@blast/core/modules/social/contracts/viewer-state.ts";
import { readSocialJsonWithSchema, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";

function distinctIds(ids: readonly string[] | undefined): string[] {
  return [...new Set(ids)];
}

/** `{ [id]: value(id) }` for every id, in request order. */
function keyed<Value>(ids: readonly string[], value: (id: string) => Value): Record<string, Value> {
  return Object.fromEntries(ids.map((id) => [id, value(id)]));
}

/**
 * `POST /api/social/viewer-state` (contract in `contracts/viewer-state.ts`):
 * the caller's reactions and follows for the ids on their screen. It reads
 * through the kit's transaction, which is the primary, so a follow or
 * reaction the caller just made is already there. Every answer is
 * `private, no-store`.
 */
export function createSocialViewerStateRoute(dependencies: Readonly<{ kit: SocialRouteKit }>) {
  const { kit } = dependencies;
  return Object.freeze({
    POST: kit.route(
      { name: SOCIAL_VIEWER_STATE_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        const body = await readSocialJsonWithSchema(context.request, socialViewerStateRequestSchema);
        const entryIds = distinctIds(body.entry_ids);
        const callsigns = distinctIds(body.callsigns);
        const presaleIds = distinctIds(body.presale_ids);
        const backersOf = distinctIds(body.backers_of);
        const buyersOf = distinctIds(body.buyers_of);
        const followsYouOf = distinctIds(body.follows_you);
        const accountId = context.account!.account_id;
        const found = await context.transaction(
          async (social) => {
            return readViewerState(social, { accountId, entryIds, callsigns, presaleIds, backersOf, buyersOf, followsYouOf, trading: context.trading, nowMs: Date.now() });
          },
          { label: "social.viewer_state" },
        );
        const state: SocialViewerStateResponse = {
          reactions: keyed(entryIds, (id) => found.reactions.get(id) ?? []),
          follows: {
            accounts: keyed(callsigns, (callsign) => found.accounts.has(callsign)),
            presales: keyed(presaleIds, (id) => found.presales.has(id)),
          },
          backers: keyed(backersOf, (id): SocialViewerBackers => found.backers.get(id) ?? { count: 0, accounts: [] }),
          ...(buyersOf.length > 0 ? { buyers: keyed(buyersOf, (id): SocialViewerBackers => found.buyers.get(id) ?? { count: 0, accounts: [] }) } : {}),
          follows_you: keyed(followsYouOf, (callsign) => found.followers.has(callsign)),
        };
        return context.json(state);
      },
    ),
  });
}

export type SocialViewerStateRoute = ReturnType<typeof createSocialViewerStateRoute>;
