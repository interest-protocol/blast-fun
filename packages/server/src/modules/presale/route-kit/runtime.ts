
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { createRatePolicyRegistry, type RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { instanceRouteLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { databaseFor } from "@blast/core/modules/read-routing/databases.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { liveWalletSession } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { presaleDeploymentGate } from "@blast/server/modules/presale/deployment/runtime.ts";
import type { AgentApiKeyVerifier } from "@blast/core/modules/presale/route-kit/contracts.ts";
import { createPresaleRouteKit, type PresaleRouteKit } from "@blast/core/modules/presale/route-kit/route.ts";

/**
 * The production kit every presale route shares, from the runtime config: the
 * site origin, Privy tokens, outside-wallet sessions (read only on
 * `account_or_wallet` routes), the shared rate-limit table
 * (`presaleRateLimiter`) unless the caller already charged the route's
 * buckets, and the process's deployment gate.
 */
export function presaleRouteKit(
  options: Readonly<{ verifyApiKey?: AgentApiKeyVerifier; limiter?: RateLimitPort }> = {},
): PresaleRouteKit {
  const config = runtimeConfig();
  let verifier: ReturnType<typeof createPrivyTokenVerifier> | undefined;
  return createPresaleRouteKit({
    expectedOrigin: config.siteOrigin,
    verifyAccessToken(token) {
      verifier ??= createPrivyTokenVerifier({
        appId: config.privy.appId,
        verificationKey: config.privy.jwtVerificationKey,
      });
      return verifier(token);
    },
    verifyApiKey: options.verifyApiKey,
    // API key lookups per client IP, counted in this instance's memory (review M2).
    apiKeyLimiter: instanceRouteLimiter(),
    walletSessions: {
      live: (token) => liveWalletSession(primaryPool(), token, new Date()),
    },
    // Failed wallet-session lookups per client IP, in this instance's memory.
    authFailures: instanceRouteLimiter(),
    limiter: options.limiter ?? presaleRateLimiter(),
    deployment: presaleDeploymentGate(),
  });
}

/**
 * The shared rate-limit table with the subject pepper and the sponsor caps
 * (`PRESALE_SPONSOR_DAILY_CAP`, `PRESALE_SPONSOR_EXEC_DAILY_CAP`), built on
 * first use. The kit and the sponsor service (which counts the sponsor's
 * budgets after its dry run) both count through it.
 */
export function presaleRateLimiter(): RateLimitPort {
  let limiter: RateLimitPort | undefined;
  return {
    consume(bucket, subject) {
      const config = runtimeConfig();
      limiter ??= new PostgresRateLimitEnforcer({
        pool: databaseFor("write"),
        subjectPepper: config.subjectPepper,
        policies: createRatePolicyRegistry(config.sponsorRatePolicy),
      });
      return limiter.consume(bucket, subject);
    },
  };
}
