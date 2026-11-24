import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import sharp from "sharp";

import { CARD_PNG_HEIGHT, CARD_PNG_WIDTH, CardInputError, CardRenderError, createSeasonZeroCardRecord, cardEditionForCrew, CARD_EDITIONS, CARD_SHARE_WIDTH, CARD_SHARE_HEIGHT, renderSeasonZeroCardPng, renderSeasonZeroCardSvg, serializeSeasonZeroCardRecord } from "@blast/server/modules/mission-control/card-renderer/index.ts";
import { makeSeasonZeroCardFixtures } from "../../../../../../packages/server/test/fixtures/modules/mission-control/card-renderer/fixtures.ts";

const PROHIBITED_COPY = /\b(?:nft|mint(?:ing)?|rarity|value allocation|reward|utility|profile url|invitation code)\b/i;

test("card and share text render identically with or without system fonts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blast-no-fonts-"));
  const config = join(directory, "fonts.conf");
  await writeFile(config, `<?xml version="1.0"?><fontconfig><dir>${directory}</dir></fontconfig>`);
  const bundledConfig = join(directory, "bundled.conf");
  // Where npm installed it (hoisted to the repository root), not under this package.
  const interFiles = join(dirname(createRequire(import.meta.url).resolve("@fontsource/inter/package.json")), "files");
  assert.ok(existsSync(interFiles), interFiles);
  await writeFile(bundledConfig, `<?xml version="1.0"?><fontconfig><dir>${interFiles}</dir></fontconfig>`);
  try {
    const render = async (fontConfig: string) => promisify(execFile)(process.execPath, [
      "--no-warnings", "--experimental-strip-types", "--input-type=module", "-e",
      `import {createHash} from "node:crypto";
       import { renderSeasonZeroCardPng } from "@blast/server/modules/mission-control/card-renderer/index.ts";
       import { makeSeasonZeroCardFixtures } from "../../packages/server/test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
       const [{record}] = await makeSeasonZeroCardFixtures();
       for (const format of ["card", "share"]) {
         const image = await renderSeasonZeroCardPng(record, {}, format);
         console.log(createHash("sha256").update(image.bytes).digest("hex"));
       }`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, FONTCONFIG_FILE: fontConfig, FONTCONFIG_PATH: directory },
      // Only a hung renderer is killed: during the full suite the two renders take 12–27 s side by side, and on a
      // loaded machine past 30 s, which killed a healthy render. The hashes must still match.
      timeout: 120_000,
    });
    const [withoutFonts, withFonts] = await Promise.all([render(config), render(bundledConfig)]);
    assert.equal(withoutFonts.stdout, withFonts.stdout, "Server fonts must not change card labels into missing-glyph boxes");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("records are versioned, provider-safe, immutable, and omit navigation secrets", async () => {
  const [fixture] = await makeSeasonZeroCardFixtures();
  const serialized = serializeSeasonZeroCardRecord(fixture.record);

  assert.equal(fixture.record.schema, "blast.season-zero-card");
  assert.equal(fixture.record.version, 3);
  assert.equal(Object.isFrozen(fixture.record), true);
  assert.equal(Object.isFrozen(fixture.record.avatar), true);
  assert.doesNotMatch(serialized, /profileUrl|providerUrl|accessToken|\"code\"/i);
  assert.doesNotMatch(serialized, PROHIBITED_COPY);
  assert.throws(
    () => createSeasonZeroCardRecord({ ...fixture.record, profileUrl: "https://x.example/member" }),
    CardInputError,
  );
  assert.throws(
    () => createSeasonZeroCardRecord({
      ...fixture.record,
      avatar: { ...fixture.record.avatar, sha256: "0".repeat(64) },
    }),
    /does not match/,
  );
});

test("every range boundary and exact-number exception resolves from crew number", () => {
  const cases = [
    [1, "quasar"], [25, "quasar"], [26, "cosmic"], [50, "cosmic"],
    [51, "prism"], [68, "prism"], [69, "manifest"], [70, "prism"], [100, "prism"],
    [101, "pearl"], [122, "pearl"], [123, "countdown"], [124, "pearl"], [150, "pearl"],
    [151, "aurora"], [200, "aurora"], [201, "silver"], [255, "silver"],
    [256, "8-bit"], [257, "silver"], [300, "silver"],
    [301, "bronze"], [500, "bronze"], [501, "lunar"], [502, "lunar"],
    [503, "sui"], [504, "lunar"], [726, "lunar"], [727, "blast-launch-day"],
    [728, "lunar"], [1000, "lunar"], [1001, "recruit"], [999999, "recruit"],
  ] as const;
  for (const [crew, edition] of cases) assert.equal(cardEditionForCrew(crew), edition);
  for (const crew of [0, -1, 1.5, NaN, Infinity, 1000000]) {
    assert.throws(() => cardEditionForCrew(crew), RangeError);
  }
});

test("clients cannot select editions or use the removed card model", async () => {
  const [fixture] = await makeSeasonZeroCardFixtures();
  const card = createSeasonZeroCardRecord({ ...fixture.record, crew: 1001, edition: "sui" });
  assert.equal(card.edition, "recruit");
  for (const obsolete of [{ style: "console" }, { gold: true }, { fleet: "zero-fleet" }, { version: 1 }]) {
    assert.throws(() => createSeasonZeroCardRecord({ ...fixture.record, ...obsolete }), CardInputError);
  }
  assert.doesNotMatch(serializeSeasonZeroCardRecord(card), /"(?:style|gold|fleet)":/);
});

test("all fourteen editions render twice to stable landscape PNGs", async () => {
  const fixtures = await makeSeasonZeroCardFixtures();
  assert.equal(fixtures.length, 14);

  assert.deepEqual(new Set(fixtures.map(({ record }) => record.edition)), new Set(CARD_EDITIONS));
  for (const fixture of fixtures) {
    const svg = renderSeasonZeroCardSvg(fixture.record);
    assert.match(svg, /viewBox="0 0 1050 750"/);
    assert.doesNotMatch(svg, PROHIBITED_COPY);

    const [first, second] = await Promise.all([
      renderSeasonZeroCardPng(fixture.record),
      renderSeasonZeroCardPng(fixture.record),
    ]);
    assert.deepEqual(first.bytes, second.bytes);
    assert.equal(first.cardId, fixture.record.cardId);
    assert.equal(first.contentType, "image/png");
    assert.equal(first.width, CARD_PNG_WIDTH);
    assert.equal(first.height, CARD_PNG_HEIGHT);

    const metadata = await sharp(first.bytes).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, CARD_PNG_WIDTH);
    assert.equal(metadata.height, CARD_PNG_HEIGHT);
  }
});

test("a renderer failure is retryable from an unchanged identity record", async () => {
  const [fixture] = await makeSeasonZeroCardFixtures();
  const before = serializeSeasonZeroCardRecord(fixture.record);
  let attempts = 0;
  const rasterize = async (svg: string) => {
    attempts += 1;
    if (attempts === 1) throw new Error("injected rasterizer outage");
    return sharp(Buffer.from(svg)).png().toBuffer();
  };

  await assert.rejects(
    renderSeasonZeroCardPng(fixture.record, { rasterize }),
    (error: unknown) => {
      assert.ok(error instanceof CardRenderError);
      assert.equal(error.retryable, true);
      assert.equal(error.cardId, fixture.record.cardId);
      return true;
    },
  );
  const retry = await renderSeasonZeroCardPng(fixture.record, { rasterize });
  assert.equal(retry.cardId, fixture.record.cardId);
  assert.equal(serializeSeasonZeroCardRecord(fixture.record), before);
  assert.equal(attempts, 2);
});

test("social previews use the x-post layout for all fourteen editions", async () => {
  const fixtures = await makeSeasonZeroCardFixtures();
  const expectedShareLine = {
    quasar: "TOP 25  ·  QUASAR",
    cosmic: "TOP 50  ·  COSMIC",
    prism: "TOP 100  ·  PRISM",
    pearl: "TOP 150  ·  PEARL",
    aurora: "TOP 200  ·  AURORA",
    silver: "TOP 300  ·  SILVER",
    bronze: "TOP 500  ·  BRONZE",
    lunar: "TOP 1000  ·  LUNAR",
    recruit: "RECRUIT  ·  FLIGHT 001",
    manifest: "1 OF 1  ·  MANIFEST FREEDOM 69",
    countdown: "1 OF 1  ·  COUNTDOWN  ·  1 · 2 · 3",
    "8-bit": "1 OF 1  ·  8-BIT  ·  PRESS START",
    sui: "1 OF 1  ·  SUI MAINNET  ·  05.03.23",
    "blast-launch-day": "1 OF 1  ·  BLAST LAUNCH  ·  07.27.25",
  } as const;
  for (const { record } of fixtures) {
    const svg = renderSeasonZeroCardSvg(record, "share");
    assert.match(svg, /viewBox="0 0 1200 675"/);
    assert.match(svg, /@your_callsign/);
    assert.ok(svg.includes(`>${expectedShareLine[record.edition]}</text>`), record.edition);
    assert.ok(svg.includes(`Crew #${record.crew.toString().padStart(4, "0")}</text>`), record.edition);
    assert.match(svg, /Now recruiting/);
    assert.match(svg, /blast\.fun/);
    const rendered = await renderSeasonZeroCardPng(record, {}, "share");
    const metadata = await sharp(rendered.bytes).metadata();
    assert.equal(metadata.width, CARD_SHARE_WIDTH);
    assert.equal(metadata.height, CARD_SHARE_HEIGHT);

    // This uncovered strip must contain the canonical soft backdrop, never
    // legible enlarged card text (the previous opacity-only workaround).
    const { data, info } = await sharp(rendered.bytes)
      .extract({ left: 840, top: 8, width: 340, height: 55 })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let sharpestEdge = 0;
    for (let y = 1; y < info.height; y++) {
      for (let x = 1; x < info.width; x++) {
        const offset = (y * info.width + x) * info.channels;
        for (let channel = 0; channel < info.channels; channel++) {
          const value = data[offset + channel];
          sharpestEdge = Math.max(sharpestEdge,
            Math.abs(value - data[offset + channel - info.channels]),
            Math.abs(value - data[offset + channel - info.width * info.channels]));
        }
      }
    }
    assert.ok(sharpestEdge <= 3, `${record.edition}: unblurred background edge (${sharpestEdge})`);
    assert.match(svg, /<feGaussianBlur stdDeviation="80" edgeMode="duplicate"\/>/);
    assert.match(svg, /<feColorMatrix type="saturate" values="1\.35"\/>/);
  }
});

test("social previews replace countdown cells with recruited X handles but keep BLASTOFF", async () => {
  const [{ record }] = await makeSeasonZeroCardFixtures();
  const svg = renderSeasonZeroCardSvg(record, "share", {
    recruitHandles: ["dobychamp", "0xPain__", "verylong_handle"],
    recruitTotal: 3,
  });
  assert.match(svg, />@dobychamp<\/text>/);
  assert.match(svg, />@0xPain__<\/text>/);
  assert.match(svg, />@verylong_ha\.\.\.<\/text>/);
  assert.match(svg, />BLASTOFF<\/text>/);
  assert.doesNotMatch(svg, />T−5<\/text>/);

  const fullCard = renderSeasonZeroCardSvg(record, "card", {
    recruitHandles: ["dobychamp"],
    recruitTotal: 1,
  });
  assert.match(fullCard, />T−5<\/text>/);
  assert.doesNotMatch(fullCard, />@dobychamp<\/text>/);
});

test("crew 69 receives the supplied Manifest identity copy", async () => {
  const fixtures = await makeSeasonZeroCardFixtures();
  const { record } = fixtures.find((fixture) => fixture.record.edition === "manifest")!;
  const svg = renderSeasonZeroCardSvg(record);

  assert.match(svg, />1 OF 1  ·  MANIFEST</);
  assert.match(svg, />MANIFEST FREEDOM 69</);
  assert.match(svg, />@blastdotfun</);
  assert.match(svg, />#0069</);
});

test("crews 123 and 256 receive the supplied one-of-one identity copy", async () => {
  const fixtures = await makeSeasonZeroCardFixtures();
  const countdown = fixtures.find((fixture) => fixture.record.edition === "countdown")!;
  const eightBit = fixtures.find((fixture) => fixture.record.edition === "8-bit")!;

  const countdownSvg = renderSeasonZeroCardSvg(countdown.record);
  assert.match(countdownSvg, />1 OF 1  ·  COUNTDOWN</);
  assert.match(countdownSvg, />3  ·  2  ·  1  ·  BLASTOFF</);
  assert.match(countdownSvg, />#0123</);
  assert.match(renderSeasonZeroCardSvg(countdown.record, "share"), /fill="url\(#shc-ban\)"/);

  const eightBitSvg = renderSeasonZeroCardSvg(eightBit.record);
  assert.match(eightBitSvg, />1 OF 1  ·  8-BIT</);
  assert.match(eightBitSvg, />PRESS START  ·  2⁸ = 256</);
  assert.doesNotMatch(eightBitSvg, />#0256</);
  assert.match(eightBitSvg, /<rect x="572" y="440" width="10" height="10"/);
});
