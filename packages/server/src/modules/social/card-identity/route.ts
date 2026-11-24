import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { CARD_IDENTITY_PATH, cardIdentityCallsigns } from "@blast/core/modules/social/contracts/card-identity.ts";
import { readCardIdentities } from "@blast/server/modules/social/card-identity/read.ts";

export function createCardIdentityRoute(dependencies: { kit: SocialRouteKit; database: () => ReadableDatabase }) {
  return dependencies.kit.route({ name: `GET ${CARD_IDENTITY_PATH}`, auth: "none", bucket: "social_read", cache: "public" }, async (context) => {
    const callsigns = cardIdentityCallsigns(new URL(context.request.url));
    if (!callsigns) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "callsigns" } });
    return context.json(await readCardIdentities(dependencies.database(), callsigns));
  });
}
