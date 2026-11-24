import { validatePnlImage } from "@blast/server/modules/share-images/renderer.ts";
import { createHash } from "node:crypto";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  readSocialBody,
  type SocialRouteKit,
} from "@blast/server/modules/social/route-kit/route.ts";
import {
  cardImageStore,
  type CardImageStore,
} from "@blast/server/modules/mission-control/card-images/store.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";
import {
  PNL_CARD_SHARE_ID,
  PNL_CARD_SHARE_MAX_BYTES,
  PNL_CARD_SHARE_PATH,
  pnlCardSharePath,
} from "@blast/core/modules/social/contracts/pnl-card-sharing.ts";

type ShareStore = () => CardImageStore | null;

const configuredStore: ShareStore = () => cardImageStore(runtimeConfig().cardImages.store);

/** Publish the exact preview, including custom artwork; no wallet history is uploaded. */
export function createPnlCardShareRoute(
  kit: SocialRouteKit,
  store: ShareStore = configuredStore,
) {
  return kit.route(
    {
      name: `POST ${PNL_CARD_SHARE_PATH}`,
      auth: "account",
      account: "required",
      bucket: "social_pnl_card_publish",
      cache: "private",
    },
    async (context) => {
      if (
        context.request.headers
          .get("content-type")
          ?.split(";", 1)[0]
          ?.trim() !== "image/png"
      ) {
        throw new SocialRouteError("invalid_request");
      }
      const images = store();
      if (!images) throw new SocialRouteError("service_unavailable");
      const bytes = await readSocialBody(
        context.request,
        PNL_CARD_SHARE_MAX_BYTES,
      );
      if (!(await validatePnlImage(bytes)))
        throw new SocialRouteError("invalid_request");
      const id = createHash("sha256").update(bytes).digest("hex");
      await images.write(`pnl-cards/${id}.png`, Buffer.from(bytes));
      return context.json({
        path: pnlCardSharePath(id, context.account!.callsign),
      });
    },
  );
}

/** Only explicitly shared snapshots are public; private profile reads stay private. */
export async function readPnlCardShare(
  id: string,
  store: ShareStore = configuredStore,
): Promise<Buffer | null> {
  if (!PNL_CARD_SHARE_ID.test(id)) return null;
  const images = store();
  if (!images) throw new SocialRouteError("service_unavailable");
  return images.read(`pnl-cards/${id}.png`);
}
