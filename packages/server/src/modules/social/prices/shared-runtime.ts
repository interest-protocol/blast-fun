import { socialPresaleDatabase } from "@blast/server/modules/social/presales/shared-runtime.ts";
import { createSocialPricesRoute } from "@blast/server/modules/social/prices/route.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";

export function createSocialPricesRuntimeRoute(kit: SocialRouteKit): ReturnType<typeof createSocialPricesRoute> {
  return createSocialPricesRoute({ kit, database: socialPresaleDatabase, publicRead: publicReadCache("prices") });
}
