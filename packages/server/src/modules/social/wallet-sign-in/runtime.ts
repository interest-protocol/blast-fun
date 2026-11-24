
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { walletChallengeRateLimiter } from "@blast/core/lib/web-security/rate-limits.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { WalletChallengeService } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialWalletSignInRoutes } from "@blast/server/modules/social/wallet-sign-in/routes.ts";

/**
 * The process's wallet sign-in handlers: the shared social kit, Mission
 * Control's wallet challenges on the social primary pool with the `wallet`
 * bucket per IP and address. Nothing to configure beyond the database and
 * `RATE_LIMIT_SUBJECT_PEPPER`.
 */
export function socialWalletSignInRoutes(): ReturnType<typeof createSocialWalletSignInRoutes> {
  return processSingleton("social.wallet-sign-in-routes", () => {
    let challenges: WalletChallengeService | undefined;
    const service = (): WalletChallengeService => {
      challenges ??= new WalletChallengeService(primaryPool(), {
        rateLimiter: walletChallengeRateLimiter(
          new PostgresRateLimitEnforcer({ pool: databaseFor("write"), subjectPepper: runtimeConfig().subjectPepper }),
        ),
      });
      return challenges;
    };
    return createSocialWalletSignInRoutes({
      kit: sharedSocialRouteKit(),
      expectedOrigin: new URL(runtimeConfig().siteOrigin).origin,
      challenges: {
        issue: (request, subject) => service().issue(request, subject),
        verify: (request, subject) => service().verify(request, subject),
      },
    });
  });
}
