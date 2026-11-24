import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialAccountWalletLister } from "@blast/server/modules/social/accounts/me-route.ts";
import { SOCIAL_REWARDS_ROUTE } from "@blast/core/modules/social/contracts/rewards.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { parseRewardsQuery, readRewardsPage, type RewardsWaitingReader } from "@blast/server/modules/social/rewards/read.ts";

export type SocialRewardsRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The caller's wallets (`social_wallet_owners`), on the primary. */
  wallets: SocialAccountWalletLister;
  /** The primary: an owner sees a payout as soon as blast-infra indexed it. Resolved per request. */
  database: () => ReadableDatabase;
  /** The deployment's network (`BLAST_NETWORK`): native publications and unpaid daily allocations use the selected network; null when unknown. */
  network: string | null;
  /** The daily relay's waiting reader on `database()` and `network`; null until it is wired (then no waiting line). */
  waiting: (() => RewardsWaitingReader) | null;
  now?: () => number;
}>;

/**
 * `GET /api/social/me/rewards?limit=&cursor=&presale=` (contract in
 * `contracts/rewards.ts`): signed in with an account, bucket `social_read`,
 * `private, no-store`. One keyset page of the payouts to the account's
 * wallets, and on a first page without a sale, what each sale paid and still
 * owes. The wallets are the caller's; no parameter names an account.
 */
export function createSocialRewardsRoute(dependencies: SocialRewardsRouteDependencies) {
  const { kit, wallets, database, network, waiting } = dependencies;
  const now = dependencies.now ?? Date.now;
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_REWARDS_ROUTE, auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        const query = parseRewardsQuery(new URL(context.request.url));
        const addresses = (await wallets.wallets(context.account!.account_id)).map((wallet) => wallet.address);
        return context.json(await readRewardsPage(database(), addresses, query, { nowMs: now(), network, waiting: waiting ? waiting() : null }));
      },
    ),
  });
}

export type SocialRewardsRoute = ReturnType<typeof createSocialRewardsRoute>;
