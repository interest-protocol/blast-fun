import type { CardEdition } from "@blast/core/modules/mission-control/card-renderer/editions.ts";
interface ArtworkCrew {
  name: string;
  avatar: string;
  role: string;
  crewNo: number;
}
declare function makeEditionArtwork(paths: { helmet: string; word: string }, backgroundForEdition?: (edition: CardEdition) => string): {
  backgroundSVG(edition: CardEdition): string;
  cardSVG(crew: ArtworkCrew, edition: CardEdition, scale: number): string;
  shareSVG(crew: ArtworkCrew, edition: CardEdition): string;
};
export = makeEditionArtwork;
