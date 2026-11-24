import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import {
  createApprovedXAvatarSnapshot,
  createSeasonZeroCardRecord,
  type SeasonZeroCardRecord,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import { renderSeasonZeroCardPng } from "@blast/server/modules/mission-control/card-renderer/render.ts";
import type { CardImageFormat } from "@blast/server/modules/mission-control/card-renderer/svg.ts";

export interface SeasonZeroCardFixture {
  readonly name: string;
  readonly record: SeasonZeroCardRecord;
}

async function fixtureAvatar(background: string, accent: string) {
  const bytes = await sharp({
    create: {
      width: 320,
      height: 320,
      channels: 4,
      background,
    },
  })
    .composite([
      {
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><circle cx="160" cy="138" r="72" fill="${accent}"/><path d="M54 320c12-87 58-130 106-130s94 43 106 130z" fill="${accent}"/><path d="M115 130h24v18h-24zm66 0h24v18h-24z" fill="#0D1117"/></svg>`,
        ),
      },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
  return createApprovedXAvatarSnapshot(bytes, "image/png");
}

/** One neutral sample for every edition. */
export async function makeSeasonZeroCardFixtures(): Promise<readonly SeasonZeroCardFixture[]> {
  const avatar = await fixtureAvatar("#142532", "#81CBA5");
  return [7, 42, 88, 142, 188, 263, 455, 812, 2451, 69, 123, 256, 503, 727].map((crew) => {
    const record = createSeasonZeroCardRecord({
      cardId: `fixture-crew-${crew}`,
      callsign: "your_callsign",
      avatar,
      crew,
      title: "Flight Director",
    });
    return { name: record.edition, record };
  });
}

export async function writeSeasonZeroCardFixtures(
  outputDirectory: string,
  fixtures?: readonly SeasonZeroCardFixture[],
  format: CardImageFormat = "card",
): Promise<readonly string[]> {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const selectedFixtures = fixtures ?? (await makeSeasonZeroCardFixtures());

  return Promise.all(
    selectedFixtures.map(async ({ name, record }) => {
      const rendered = await renderSeasonZeroCardPng(record, {}, format);
      const path = join(directory, `${name}.png`);
      await writeFile(path, rendered.bytes);
      return path;
    }),
  );
}

function fixtureOutputArgument(argv: readonly string[]): string {
  const outIndex = argv.indexOf("--out");
  if (outIndex >= 0 && argv[outIndex + 1]) return argv[outIndex + 1];
  return "/tmp/blast-season-zero-card-fixtures";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const fixtures = await makeSeasonZeroCardFixtures();
  const paths = await writeSeasonZeroCardFixtures(
    fixtureOutputArgument(args),
    fixtures,
    args.includes("--share") ? "share" : "card",
  );
  process.stdout.write(`${paths.join("\n")}\n`);
}
