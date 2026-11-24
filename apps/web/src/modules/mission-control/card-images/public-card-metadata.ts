import { publicCardSharePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import type { Metadata } from "next";

import { SITE_ORIGIN } from "#web/lib/site.ts";
import { publicCardImagePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";

export function publicCardMetadata(
  card: Readonly<{ callsign: string; crew: number }>,
  cardId: string,
  recruitTotal = 0,
): Metadata {
  const title = `BLAST // CREW #${card.crew}`;
  const description = `@${card.callsign} has recruited ${recruitTotal} ${recruitTotal === 1 ? "person" : "people"} to BLAST Mission Control.`;
  const image = new URL(publicCardImagePath(cardId, "share", recruitTotal), SITE_ORIGIN).href;

  return {
    title,
    description,
    alternates: { canonical: `/card/${cardId}` },
    openGraph: {
      type: "website",
      title,
      description,
      url: new URL(publicCardSharePath(cardId, recruitTotal), SITE_ORIGIN).href,
      images: [{
        url: image,
        width: 1200,
        height: 675,
        alt: `BLAST recruitment card for @${card.callsign}, showing ${recruitTotal} recruits`,
      }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      site: "@blastdotfun",
      creator: `@${card.callsign}`,
      images: [image],
    },
  };
}
