import { SuiGrpcClient } from "@mysten/sui/grpc";

import { isTradingVisible } from "@blast/core/lib/social-flag.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { boundedFetch } from "@blast/server/lib/bounded-fetch.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { trafficRateLimiter } from "@blast/core/modules/web-security/traffic-rate-limits.ts";
import { instanceRouteLimiter } from "@blast/core/modules/web-security/route-limits.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { liveWalletSession } from "@blast/core/modules/social/wallet-sign-in/sessions.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialRouteKit, type SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";

/**
 * The process's account resolver and wallet lister. `me`, account resolution
 * and every social write use the primary; feed, profile and "what's
 * happening" reads use the replica.
 */
export function socialAccounts(): PostgresSocialAccounts {
  return processSingleton("social.accounts", () => new PostgresSocialAccounts(primaryPool));
}

/**
 * The production kit every social route shares, from the runtime config: the
 * site origin, Privy tokens, wallet sessions (Slush sign-in) on the primary,
 * distributed read traffic limits (`readLimiter`, else `trafficRateLimiter`),
 * the route metric sample rate, the primary pool for account resolution
 * and writes, and the request's trading flag (`isTradingVisible`). The
 * partner API builds its own kit here too.
 */
export function socialRouteKit(readLimiter?: RateLimitPort): SocialRouteKit {
  const config = runtimeConfig();
  let verifier: ReturnType<typeof createPrivyTokenVerifier> | undefined;
  return createSocialRouteKit({
    expectedOrigin: config.siteOrigin,
    verifyAccessToken(token) {
      verifier ??= createPrivyTokenVerifier({
        appId: config.privy.appId,
        verificationKey: config.privy.jwtVerificationKey,
      });
      return verifier(token);
    },
    limiter: readLimiter ?? trafficRateLimiter(),
    accounts: socialAccounts(),
    // Failed wallet-session lookups per client IP, in this instance's memory (review L4).
    authFailures: instanceRouteLimiter(),
    walletSessions: {
      live: (token) => liveWalletSession(primaryPool(), token, new Date()),
    },
    primary: primaryPool,
    metricSampleRate: config.social.routeMetricSampleRate,
    tradingVisible: () => isTradingVisible(),
  });
}

/** The process's shared social kit. */
export function sharedSocialRouteKit(): SocialRouteKit {
  return processSingleton("social.route-kit", () => socialRouteKit());
}

/**
 * A mainnet client on the configured node (`PRESALE_SUI_GRPC_URL`, else the
 * public fullnode), one per `key` per process.
 */
export function socialMainnetClient(key: string): SuiGrpcClient {
  return processSingleton(key, () =>
    new SuiGrpcClient({ network: "mainnet", baseUrl: runtimeConfig().suiNodeUrl, format: "text", fetch: boundedFetch(8_000) }));
}
