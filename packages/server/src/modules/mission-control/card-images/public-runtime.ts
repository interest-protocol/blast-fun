import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import type {
  PublishedCardSnapshot,
  CardImageFormat,
} from "@blast/core/modules/mission-control/card-images/contracts.ts";
import { parseCardPage } from "@blast/core/modules/mission-control/card-images/page.ts";
import { publishedCardSnapshot } from "./published-card.ts";
import {
  canonicalCardImageRedirect,
  cardImageQuery,
  missionControlPublishedCardDigests,
  publicCardImageResponse,
} from "./route.ts";
import { missionControlCardImages } from "./service.ts";

type ImageDependencies = Readonly<{
  limit: typeof withRouteLimits;
  image: (
    id: string,
    format: CardImageFormat,
    recruitTotal?: number,
  ) => Promise<Response>;
}>;

export function createPublicCardImageRoute(dependencies: ImageDependencies) {
  return async (request: Request, client: ClientAddress, id: string): Promise<Response> => {
    const redirect = canonicalCardImageRedirect(request, id);
    if (redirect) return redirect;
    const { format, recruitTotal } = cardImageQuery(
      new URL(request.url).searchParams,
    );
    return dependencies.limit(client, ["mission_control_card_image"], () =>
      dependencies.image(id, format, recruitTotal),
    );
  };
}

export const publicCardImageRoute = createPublicCardImageRoute({
  limit: withRouteLimits,
  image: (id, format, recruitTotal) =>
    publicCardImageResponse(
      id,
      {
        images: {
          cached: (key) => missionControlCardImages().cached(key),
          image: (input) => missionControlCardImages().image(input),
        },
        published: missionControlPublishedCardDigests(),
        publishedCard: (cardId) => publishedCardSnapshot(cardId),
      },
      format,
      recruitTotal,
    ),
});

export function createCardPageRoute(
  published: (id: string) => Promise<PublishedCardSnapshot | null>,
) {
  return async (id: string): Promise<Response> => {
    const snapshot = await published(id);
    const page = snapshot
      ? parseCardPage(
          JSON.stringify({
            cardId: id.toLowerCase(),
            callsign: snapshot.record.callsign,
            crew: snapshot.record.crew,
            recruitTotal: snapshot.recruitTotal,
          }),
          id,
        )
      : null;
    return Response.json(page, {
      headers: { "Cache-Control": "private, no-store" },
    });
  };
}

export const cardPageRoute = createCardPageRoute(publishedCardSnapshot);
