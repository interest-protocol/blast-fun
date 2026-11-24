import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialAccountWalletLister } from "@blast/server/modules/social/accounts/me-route.ts";
import { profileCallsignParameter } from "@blast/server/modules/social/profiles/route.ts";
import { readPublicPortfolioOwner } from "@blast/server/modules/social/portfolio/public-route.ts";
import { readLifetimePnl } from "@blast/server/modules/social/portfolio/pnl.ts";

export type SocialPnlDependencies = Readonly<{
  kit: SocialRouteKit;
  wallets: SocialAccountWalletLister;
  /** Primary: the owner and public profile use the same indexed wallet history. */
  database: () => ReadableDatabase;
  now?: () => number;
}>;

export function createSocialPnlRoutes({ kit, wallets, database, now = Date.now }: SocialPnlDependencies) {
  const read = async (accountId: string) => readLifetimePnl(database(), await wallets.wallets(accountId), now());
  return Object.freeze({
    GET: kit.route(
      { name: "GET /api/social/me/pnl", auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        if (!context.account) throw new TypeError("The kit loads the required account.");
        return context.json(await read(context.account.account_id));
      },
    ),
    PUBLIC: kit.route(
      { name: "GET /api/social/profiles/{callsign}/pnl", auth: "none", bucket: "social_read_portfolio", cache: "public-fresh" },
      async (context) => {
        const callsign = profileCallsignParameter(context.request, "/pnl");
        const owner = await readPublicPortfolioOwner(database(), callsign);
        if (!owner) throw new SocialRouteError("not_found");
        if (owner.private || !owner.portfolio_public) throw new SocialRouteError("portfolio_private");
        return context.json(await read(owner.account_id));
      },
    ),
  });
}
