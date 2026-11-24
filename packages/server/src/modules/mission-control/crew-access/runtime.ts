import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { createPrivyOnboardingAdapter } from "@blast/server/lib/privy-adapter/adapter.ts";
import { randomUUID } from "node:crypto";
import { privyGateway } from "@blast/server/config/privy-gateway.ts";
import { walletChallengeRateLimiter } from "@blast/core/lib/web-security/rate-limits.ts";
import { createCrewAccessRouteHandlers, CrewAccessService } from "./index.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { MemberSessionService } from "@blast/server/modules/mission-control/member-sessions/index.ts";
import { WalletChallengeService } from "@blast/server/modules/mission-control/wallet-challenges/index.ts";
import { missionControlRoute, unavailable, type MissionControlRoute } from "../route-kit.ts";

export function crewRestoreRoute(
  request: Request,
  client: ClientAddress,
  method: "issue" | "verify",
): Promise<Response> {
  const id = method === "issue" ? "mission-control.restore.challenge" : "mission-control.restore.verify";
  return missionControlRoute(id, client, (route) => crewAccessHandlers(route)[method](request), (cause) =>
    unavailable(
      {
        code: "CREW_ACCESS_UNAVAILABLE",
        message: "Crew access is temporarily unavailable.",
        requestId: randomUUID(),
        fields: { restored: false },
      },
      cause,
    ));
}

function crewAccessHandlers(route: MissionControlRoute) {
  const config = runtimeConfig();
  const pool = primaryPool();
  const sessions = new MemberSessionService({
    policy: config.memberSessionPolicy,
    pool,
  });
  const adapter = createPrivyOnboardingAdapter({
    appId: config.privy.appId,
    gateway: privyGateway(),
  });
  return createCrewAccessRouteHandlers({
    challenge: new WalletChallengeService(pool, {
      rateLimiter: walletChallengeRateLimiter(route.limiter),
    }),
    expectedOrigin: config.siteOrigin,
    limiter: route.limiter,
    rateSubject: (address) => ({ ip: route.client.rateKey, address }),
    resolveEmbedded: (accessToken) =>
      adapter.verifyXIdentityAndGetExistingWallet(accessToken),
    service: new CrewAccessService({ pool, sessions }),
  });
}
