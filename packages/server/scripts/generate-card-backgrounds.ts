import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import makeEditionArtwork from "../src/modules/mission-control/card-renderer/edition-artwork.cjs";
import paths from "@blast/core/modules/mission-control/card-renderer/brand-paths.json" with { type: "json" };
import { CARD_EDITIONS } from "@blast/core/modules/mission-control/card-renderer/editions.ts";

// Bake the expensive procedural art once. Personal identity is always rendered at request time.
const directory = new URL("../assets/mission-control/editions/", import.meta.url);
await mkdir(directory, { recursive: true });
const artwork = makeEditionArtwork(paths);
// These supplied one-of-one backgrounds are curated assets extracted from their
// approved card masters, rather than procedural handoff editions.
const curatedBackgrounds = new Set(["countdown", "8-bit"]);
for (const edition of CARD_EDITIONS) {
  if (curatedBackgrounds.has(edition)) {
    console.log(`${edition} (curated)`);
    continue;
  }
  const bytes = await sharp(Buffer.from(artwork.backgroundSVG(edition))).png().toBuffer();
  await writeFile(new URL(`${edition}.png`, directory), bytes);
  console.log(edition);
}
