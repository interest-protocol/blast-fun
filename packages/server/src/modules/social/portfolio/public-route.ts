import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { timed } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_PUBLIC_PORTFOLIO_HISTORY_ROUTE, SOCIAL_PUBLIC_PORTFOLIO_ROUTE } from "@blast/core/modules/social/contracts/portfolio.ts";
import { portfolioHistoryRange, readPortfolioHistory } from "@blast/server/modules/social/portfolio/trend.ts";
import { profileCallsignParameter } from "@blast/server/modules/social/profiles/route.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { assemblePortfolio } from "@blast/server/modules/social/portfolio/route.ts";

type OwnerRow = { account_id: string; private: boolean; portfolio_public: boolean; portfolio_public_since_ms: string | null };

/**
 * The account holding the callsign, through `social_account_callsigns` (0059:
 * a unique-index lookup per branch; the replica may read a member's callsign
 * there, never the profile), with whether its owner opened the portfolio and
 * since when (0097, the trend's public window).
 */
const OWNER_BY_CALLSIGN = `
  SELECT a.account_id::text AS account_id, a.privacy = 'private' AS private, a.portfolio_public,
    floor(extract(epoch FROM a.portfolio_public_since) * 1000)::bigint::text AS portfolio_public_since_ms
  FROM social_account_callsigns c
  JOIN social_accounts a ON a.account_id = c.account_id
  WHERE c.callsign = $1`;


export async function readPublicPortfolioOwner(db: ReadableDatabase, callsign: string): Promise<OwnerRow | null> {
  return (await db.read<OwnerRow>(OWNER_BY_CALLSIGN, [callsign])).rows[0] ?? null;
}


export type SocialPublicPortfolioRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The read replica in production (`socialPublicPortfolioDatabase`). Resolved per request. */
  database: () => ReadableDatabase;
  now?: () => number;
}>;

/**
 * `GET /api/social/profiles/{callsign}/portfolio` (OA-10; contract in
 * `contracts/portfolio.ts`): `auth: "none"`, bucket `social_read_portfolio`, `cache:
 * "public-fresh"`. It answers only while the owner chose "Public portfolio"
 * and the account is public (`portfolio_private` otherwise), reads the
 * replica, and answers the owner's portfolio exactly as `/me/portfolio`
 * would, cost basis included (R3-32), without naming a wallet — except the
 * 30-day trend, which shows only the days since the portfolio became public
 * (the owner's answer of 2026-10-06; `trend.ts`). Edge-cached for 10 s and
 * never served stale (OA-30, amending R3-32-AC-7), so a portfolio made
 * private stops answering within 10 s; a refusal is never cached.
 */
export function createSocialPublicPortfolioRoute(dependencies: SocialPublicPortfolioRouteDependencies) {
  const { kit, database } = dependencies;
  const now = dependencies.now ?? Date.now;
  return Object.freeze({
    GET: kit.route(
      { name: SOCIAL_PUBLIC_PORTFOLIO_ROUTE, auth: "none", bucket: "social_read_portfolio", cache: "public-fresh" },
      async (context) => {
        const callsign = profileCallsignParameter(context.request, "/portfolio");
        const body = await timed("social.public_portfolio", async () => {
          const db = database();
          const owner = await readPublicPortfolioOwner(db, callsign);
          if (!owner) throw new SocialRouteError("not_found");
          if (owner.private || !owner.portfolio_public) throw new SocialRouteError("portfolio_private");
          const addresses = await readAccountAddresses(db, owner.account_id);
          return assemblePortfolio({
            db,
            accountId: owner.account_id,
            addresses,
            now,
            // 0097's CHECK makes it present whenever the portfolio is public; were it missing, the history would start now.
            trendPublicSinceMs: owner.portfolio_public_since_ms === null ? now() : Number(owner.portfolio_public_since_ms),
          });
        }, {}, { sampleRate: 0.1 });
        return context.json(body);
      },
    ),
    /** Redesign gap 13: a public portfolio's chart range, only the days since it became public; refused as `/portfolio` refuses. */
    HISTORY: kit.route(
      { name: SOCIAL_PUBLIC_PORTFOLIO_HISTORY_ROUTE, auth: "none", bucket: "social_read_portfolio", cache: "public-fresh" },
      async (context) => {
        const callsign = profileCallsignParameter(context.request, "/portfolio/history");
        const range = portfolioHistoryRange(new URL(context.request.url).searchParams);
        const db = database();
        const owner = await readPublicPortfolioOwner(db, callsign);
        if (!owner) throw new SocialRouteError("not_found");
        if (owner.private || !owner.portfolio_public) throw new SocialRouteError("portfolio_private");
        const publicSinceMs = owner.portfolio_public_since_ms === null ? now() : Number(owner.portfolio_public_since_ms);
        return context.json(await readPortfolioHistory(db, owner.account_id, now(), range, publicSinceMs));
      },
    ),
  });
}
