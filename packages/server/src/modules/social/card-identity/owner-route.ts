import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { CardImageBusyError } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import { cardImageBody } from "@blast/server/modules/mission-control/card-images/route.ts";
import type { CardImageService } from "@blast/server/modules/mission-control/card-images/service.ts";
import type { SeasonZeroCardRecord } from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import { OWNER_CARD_PATH } from "@blast/core/modules/social/contracts/card-identity.ts";

/** The social session's own card, including unpublished cards; no card/profile id is accepted from the caller. */
export function createOwnerCardRoute(dependencies: {
  kit: SocialRouteKit; database: () => ReadableDatabase; images: Pick<CardImageService, "image">;
}) {
  return dependencies.kit.route({ name: `GET ${OWNER_CARD_PATH}`, auth: "account", account: "required", bucket: "social_read", cache: "private" }, async (context) => {
    const { rows } = await dependencies.database().read<{ card_record: SeasonZeroCardRecord }>(`
      SELECT c.card_record FROM social_accounts a
      JOIN mission_control_cards c ON c.profile_id = a.profile_id
      WHERE a.account_id = $1`, [context.account!.account_id]);
    const record = rows[0]?.card_record;
    if (!record) throw new SocialRouteError("not_found");
    try {
      const image = await dependencies.images.image({ format: "card", record });
      return new Response(cardImageBody(image.bytes), { headers: {
        "Cache-Control": "private, no-store", "Content-Type": image.contentType,
        "Content-Length": String(image.bytes.byteLength),
      } });
    } catch (error) {
      if (error instanceof CardImageBusyError) throw new SocialRouteError("service_unavailable");
      throw error;
    }
  });
}
