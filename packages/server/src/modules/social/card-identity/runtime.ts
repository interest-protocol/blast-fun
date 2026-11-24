import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { missionControlCardImages } from "../../mission-control/card-images/service.ts";
import { sharedSocialRouteKit } from "../route-kit/shared-runtime.ts";
import { createCardIdentityRoute } from "./route.ts";
import { createOwnerCardRoute } from "./owner-route.ts";

export function cardIdentitiesRoute(request: Request, client: ClientAddress): Promise<Response> {
  return createCardIdentityRoute({
    kit: sharedSocialRouteKit(),
    database: () =>
      autocommitReader(primaryPool(), "social", {
        label: "social.card_identity",
      }),
  })(request, client);
}

export function ownerCardRoute(request: Request, client: ClientAddress): Promise<Response> {
  return createOwnerCardRoute({
    kit: sharedSocialRouteKit(),
    database: () =>
      autocommitReader(primaryPool(), "social", {
        label: "social.owner_card",
      }),
    images: { image: (input) => missionControlCardImages().image(input) },
  })(request, client);
}
