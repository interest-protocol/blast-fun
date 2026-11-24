
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { walletChallengeRateLimiter } from "@blast/core/lib/web-security/rate-limits.ts";
import { WalletChallengeService } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { sharedSocialRouteKit } from "@blast/server/modules/social/route-kit/shared-runtime.ts";
import { createSocialWalletRoutes, type SocialWalletChallenges } from "@blast/server/modules/social/wallets/route.ts";

/**
 * Mission Control's wallet-challenge service on the social primary pool,
 * with its per-IP-and-address `wallet` limit on the shared rate-limit table
 * (`RATE_LIMIT_SUBJECT_PEPPER`). Signatures are checked by
 * `verifySuiPersonalMessage` (a zkLogin signature asks the mainnet fullnode).
 */
function socialWalletChallenges(): SocialWalletChallenges {
  return processSingleton("social.wallet-challenges", () => {
    const limiter = new PostgresRateLimitEnforcer({ pool: databaseFor("write"), subjectPepper: runtimeConfig().subjectPepper });
    return new WalletChallengeService(primaryPool(), {
      rateLimiter: walletChallengeRateLimiter(limiter),
    });
  });
}

/** The process's wallet-link handlers over the shared social kit. */
export function socialWalletRoutes(): ReturnType<typeof createSocialWalletRoutes> {
  return processSingleton("social.wallet-routes", () =>
    createSocialWalletRoutes({ kit: sharedSocialRouteKit(), challenges: () => socialWalletChallenges(), origin: runtimeConfig().siteOrigin }));
}
