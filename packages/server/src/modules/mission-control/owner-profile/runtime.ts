import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import type { OwnerCardImages } from "@blast/core/modules/mission-control/card-images/render-port.ts";
import { MemberSessionService } from "../member-sessions/service.ts";
import { OwnerRecruitCursorCodec } from "./cursor.server.ts";
import { ownerProfileErrorResponse } from "./errors.ts";
import { createOwnerRouteHandlers } from "./route.ts";
import { OwnerProfileService } from "./service.ts";
import { missionControlCardImages } from "../card-images/service.ts";
import { missionControlRoute } from "../route-kit.ts";

export function ownerRouteHandlers(
  cardImages: OwnerCardImages,
): ReturnType<typeof createOwnerRouteHandlers> {
  const config = runtimeConfig();
  const pool = primaryPool();
  const session = new MemberSessionService({ policy: config.memberSessionPolicy, pool });
  const service = new OwnerProfileService({
    cardImages,
    cursor: new OwnerRecruitCursorCodec(config.ownerCursorKey),
    pool,
  });
  return createOwnerRouteHandlers({
    authenticate: (request) => session.authorize(request),
    expectedOrigin: config.siteOrigin,
    service,
  });
}

const cardImages: OwnerCardImages = {
  image: (input) => missionControlCardImages().image(input),
};

const ROUTE_IDS = {
  owner: "mission-control.owner",
  recruits: "mission-control.owner.recruits",
  displayName: "mission-control.owner.display-name",
  card: "mission-control.owner.card",
} as const;

export function ownerProfileRoute(
  request: Request,
  client: ClientAddress,
  method: keyof typeof ROUTE_IDS,
): Promise<Response> {
  return missionControlRoute(
    ROUTE_IDS[method],
    client,
    () => ownerRouteHandlers(cardImages)[method](request),
    ownerProfileErrorResponse,
  );
}
