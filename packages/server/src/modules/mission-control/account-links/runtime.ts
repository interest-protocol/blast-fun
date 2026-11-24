import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { privyGateway } from "@blast/server/config/privy-gateway.ts";
import { createPrivyOnboardingAdapter } from "@blast/server/lib/privy-adapter/adapter.ts";
import { walletChallengeRateLimiter } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  AccountLinksService,
  createAccountLinksRouteHandlers,
} from "./index.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { MemberSessionService } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import { WalletChallengeService } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { missionControlRoute, unavailable, type MissionControlRoute } from "../route-kit.ts";

const ROUTE_IDS = {
  list: "mission-control.owner.wallets",
  primary: "mission-control.owner.wallets.primary",
  issue: "mission-control.owner.wallets.challenge",
  link: "mission-control.owner.wallets.link",
} as const;

export function accountWalletRoute(
  request: Request,
  client: ClientAddress,
  method: keyof typeof ROUTE_IDS,
): Promise<Response> {
  return missionControlRoute(ROUTE_IDS[method], client, (route) => accountLinksHandlers(route)[method](request), (cause) =>
    unavailable(
      { code: "ACCOUNT_LINK_UNAVAILABLE", message: "Account linking is temporarily unavailable." },
      cause,
    ));
}

function accountLinksHandlers(route: MissionControlRoute) {
  const config = runtimeConfig();
  const pool = primaryPool();
  const sessions = new MemberSessionService({
    policy: config.memberSessionPolicy,
    pool,
  });
  return createAccountLinksRouteHandlers({
    authenticate: (request) => sessions.authorize(request),
    challenge: new WalletChallengeService(pool, {
      rateLimiter: walletChallengeRateLimiter(route.limiter),
    }),
    expectedOrigin: config.siteOrigin,
    rateSubject: (address) => ({ ip: route.client.rateKey, address }),
    resolveEmbedded: (accessToken) =>
      createPrivyOnboardingAdapter({
        appId: config.privy.appId,
        gateway: privyGateway(),
      }).verifyXIdentityAndGetExistingWallet(accessToken),
    service: new AccountLinksService({ pool }),
  });
}
