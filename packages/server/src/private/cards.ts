import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import { CARD_IMAGE_PATH, CARD_PAGE_PATH, PNL_CARD_IMAGE_PATH, PNL_CARD_PAGE_PATH } from "@blast/core/modules/backend-api/private/card-contracts.ts";
import { withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import {
  cardIdentitiesRoute,
  ownerCardRoute,
} from "../modules/social/card-identity/runtime.ts";
import {
  cardPageRoute,
  publicCardImageRoute,
} from "../modules/mission-control/card-images/public-runtime.ts";
import {
  pnlCardImageRoute,
  pnlCardPageRoute,
  pnlCardPublishRoute,
} from "../modules/social/pnl-card-runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export function cardHandlers(limit = withRouteLimits) {
  return {
    "social.card-identities": (request, { client }) => cardIdentitiesRoute(request, client),
    "social.owner-card": (request, { client }) => ownerCardRoute(request, client),
    "social.pnl-card.publish": (request, { client }) => pnlCardPublishRoute(request, client),
    "mission-control.card.page": (request, { client }) =>
      limit(client, ["mission_control_card_image"], () => cardPageRoute(cardId(CARD_PAGE_PATH, request))),
    "mission-control.card.image": (request, { client }) =>
      publicCardImageRoute(request, client, cardId(CARD_IMAGE_PATH, request)),
    "social.pnl-card.page": (request, { client }) =>
      limit(client, ["mission_control_card_image"], () => pnlCardPageRoute(cardId(PNL_CARD_PAGE_PATH, request))),
    "social.pnl-card.image": (request, { client }) => pnlCardImageRoute(client, cardId(PNL_CARD_IMAGE_PATH, request)),
  } satisfies PrivateHandlers;
}

/** The card's `:id`, URL-decoded once; "" when it does not decode. */
function cardId(path: typeof CARD_PAGE_PATH | typeof CARD_IMAGE_PATH | typeof PNL_CARD_PAGE_PATH | typeof PNL_CARD_IMAGE_PATH, request: Request): string {
  return routeParams(path, new URL(request.url).pathname)?.id ?? "";
}
