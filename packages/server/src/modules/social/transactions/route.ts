import { SOCIAL_TRANSACTIONS_ROUTE } from "@blast/core/modules/social/contracts/transactions.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { parseTransactionsQuery, readTransactionsPage } from "@blast/server/modules/social/transactions/read.ts";

export type SocialTransactionsRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The primary: the log is personal data, and an owner reads what they just sent. Resolved per request. */
  database: () => ReadableDatabase;
}>;

/**
 * `GET /api/social/me/transactions?limit=&cursor=` (contract in
 * `contracts/transactions.ts`): signed in with an account, bucket
 * `social_read`, `private, no-store`. One keyset page of the caller's
 * logged transactions, newest first, each with its explorer link on the
 * account's explorer. The account is the caller's; no parameter names one.
 */
export function createSocialTransactionsRoute(dependencies: SocialTransactionsRouteDependencies) {
  const { kit, database } = dependencies;
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_TRANSACTIONS_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        const query = parseTransactionsQuery(new URL(context.request.url));
        return context.json(await readTransactionsPage(database(), context.account!.account_id, query));
      },
    ),
  });
}

export type SocialTransactionsRoute = ReturnType<typeof createSocialTransactionsRoute>;
