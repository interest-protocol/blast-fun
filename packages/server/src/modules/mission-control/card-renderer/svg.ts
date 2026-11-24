import type { CardImageFormat } from "@blast/core/modules/mission-control/card-images/render-port.ts";
import { readFileSync } from "node:fs";
import { cardAssetPath } from "@blast/server/lib/card-assets.ts";
import type { CardEdition } from "@blast/core/modules/mission-control/card-renderer/editions.ts";
import {
  createSeasonZeroCardRecord,
  createShareCardStats,
  type SeasonZeroCardRecord,
  type ShareCardStats,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import makeEditionArtwork from "@blast/server/modules/mission-control/card-renderer/edition-artwork.cjs";
import paths from "@blast/core/modules/mission-control/card-renderer/brand-paths.json" with { type: "json" };

export const CARD_PNG_WIDTH = 2100;
export const CARD_PNG_HEIGHT = 1500;
export const CARD_SHARE_WIDTH = 1200;
export const CARD_SHARE_HEIGHT = 675;
export type { CardImageFormat } from "@blast/core/modules/mission-control/card-images/render-port.ts";

// Twelve immutable art assets; cache only public backgrounds, never personal cards.
const backgrounds = new Map<CardEdition, string>();
const artwork = makeEditionArtwork(paths, (edition) => {
  let background = backgrounds.get(edition);
  if (!background) {
    background = `data:image/png;base64,${readFileSync(cardAssetPath(`editions/${edition}.png`)).toString("base64")}`;
    backgrounds.set(edition, background);
  }
  return background;
});

/** All surfaces use the same approved artwork and server-derived edition. */
export function renderSeasonZeroCardSvg(
  input: SeasonZeroCardRecord,
  format: CardImageFormat = "card",
  stats: ShareCardStats = { recruitHandles: [], recruitTotal: 0 },
): string {
  const record = createSeasonZeroCardRecord(input);
  const shareStats = createShareCardStats(stats);
  const crew = {
    name: record.callsign,
    avatar: `data:${record.avatar.mediaType};base64,${record.avatar.bytesBase64}`,
    role: record.title,
    crewNo: record.crew,
    ...(format === "share" ? {
      recruitHandles: shareStats.recruitHandles,
      recruitTotal: shareStats.recruitTotal,
    } : {}),
  };
  return format === "share"
    ? artwork.shareSVG(crew, record.edition)
    : artwork.cardSVG(crew, record.edition, 2);
}
