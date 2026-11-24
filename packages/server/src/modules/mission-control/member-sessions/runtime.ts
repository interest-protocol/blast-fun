import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { createMemberSessionLogoutHandler } from "./logout.ts";
import { memberSessionErrorResponse } from "./errors.ts";
import { MemberSessionService } from "./service.ts";
import { missionControlRoute } from "../route-kit.ts";

export function memberLogoutRoute(request: Request, client: ClientAddress): Promise<Response> {
  return missionControlRoute("mission-control.logout", client, () => {
    const config = runtimeConfig();
    const service = new MemberSessionService({ policy: config.memberSessionPolicy, pool: primaryPool() });
    return createMemberSessionLogoutHandler({ expectedOrigin: config.siteOrigin, service })(request);
  }, memberSessionErrorResponse);
}
