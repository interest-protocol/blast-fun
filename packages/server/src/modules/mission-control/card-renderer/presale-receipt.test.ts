import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

import sharp from "sharp";
import { cardAssetPath } from "@blast/server/lib/card-assets.ts";

import { CARD_PNG_HEIGHT, CARD_PNG_WIDTH, CARD_SHARE_HEIGHT, CARD_SHARE_WIDTH, createPresaleReceiptLogo, createPresaleReceiptRecord, formatQuoteAmount, PRESALE_RECEIPT_LOGO_SIZE, PRESALE_RECEIPT_RENDERER_VERSION, PresaleReceiptInputError, receiptDisplayText, renderPresaleReceiptPng, renderPresaleReceiptSvg, type PresaleReceiptRecord } from "@blast/server/modules/mission-control/card-renderer/index.ts";

/**
 * T-012 (AC-097, AC-098, AC-100): the presale receipt layout. It reuses the
 * Mission Control card's frame, monitor, banner and crew-number type; the
 * monitor shows the sale coin's logo, or a monogram mark without one.
 */

const PRESALE = `0x${"a1".repeat(32)}`;
const WALLET = `0x${"7d".repeat(32)}`;
const SALE_TOKEN = `0x${"3f".repeat(32)}::froggy::FROGGY`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

async function greenLogo() {
  const bytes = await sharp({
    create: { width: PRESALE_RECEIPT_LOGO_SIZE, height: PRESALE_RECEIPT_LOGO_SIZE, channels: 4, background: "#00ff00" },
  }).png().toBuffer();
  return createPresaleReceiptLogo(bytes);
}

function receipt(overrides: Partial<PresaleReceiptRecord> = {}): PresaleReceiptRecord {
  return createPresaleReceiptRecord({
    schema: "blast.presale-receipt",
    version: 1,
    presaleId: PRESALE,
    wallet: WALLET,
    saleToken: SALE_TOKEN,
    quote: USDC,
    amountCommitted: "2500000000",
    quoteSymbol: "USDC",
    quoteDecimals: 6,
    coinName: "Froggy",
    coinSymbol: "FROGGY",
    logo: null,
    crew: 1042,
    ...overrides,
  });
}

/** The RGBA pixel at (x, y). */
async function pixel(png: Buffer, x: number, y: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
}

test("the record is the published shape, normalized and immutable", async () => {
  const logo = await greenLogo();
  const record = receipt({ logo });
  assert.deepEqual(Object.keys(record).sort(), [
    "amountCommitted", "coinName", "coinSymbol", "crew", "logo", "presaleId", "quote", "quoteDecimals",
    "quoteSymbol", "saleToken", "schema", "version", "wallet",
  ]);
  assert.equal(record.schema, "blast.presale-receipt");
  assert.equal(record.version, 1);
  assert.ok(Object.isFrozen(record));
  assert.equal(record.logo?.sha256, createHash("sha256").update(Buffer.from(record.logo!.bytes, "base64")).digest("hex"));
  // Re-validating a record changes nothing.
  assert.deepEqual(createPresaleReceiptRecord(structuredClone(record)), record);
});

test("records refuse malformed identities, amounts, text and logos", async () => {
  const logo = await greenLogo();
  for (const bad of [
    { presaleId: "0x1" },
    { wallet: WALLET.toUpperCase() },
    { saleToken: "not a coin type" },
    { amountCommitted: "-1" },
    { amountCommitted: "18446744073709551616" },
    { amountCommitted: "01" },
    { quoteDecimals: 1.5 },
    { quoteDecimals: 40 },
    { coinName: "" },
    { coinName: "a\u0000b" },
    { coinSymbol: "X".repeat(17) },
    { crew: 0 },
    { crew: 1.5 },
    { logo: { ...logo, sha256: "0".repeat(64) } },
    { logo: { sha256: createHash("sha256").update("<svg/>").digest("hex"), bytes: Buffer.from("<svg/>").toString("base64") } },
    { schema: "blast.season-zero-card" },
    { version: 2 },
    { extra: true },
  ]) {
    assert.throws(() => receipt(bad as Partial<PresaleReceiptRecord>), PresaleReceiptInputError, JSON.stringify(bad));
  }
});

test("display text drops control characters, collapses space and shortens with an ellipsis", () => {
  assert.equal(receiptDisplayText("  Froggy \n\t Coin \u0007", 32), "Froggy Coin");
  assert.equal(receiptDisplayText("A".repeat(40), 32), `${"A".repeat(31)}…`);
  assert.equal(receiptDisplayText(receiptDisplayText("A".repeat(40), 32), 32), `${"A".repeat(31)}…`);
  assert.equal(receiptDisplayText("\u0000\u0001", 32), "");
});

test("amounts are Quote units, grouped, truncated never rounded up", () => {
  assert.equal(formatQuoteAmount("2500000000", 6), "2,500");
  assert.equal(formatQuoteAmount("1234567891", 6), "1,234.5678");
  assert.equal(formatQuoteAmount("1999999", 6), "1.9999");
  assert.equal(formatQuoteAmount("500000000", 9), "0.5");
  assert.equal(formatQuoteAmount("1", 9), "0.000000001");
  assert.equal(formatQuoteAmount("42", 0), "42");
  assert.equal(formatQuoteAmount("18446744073709551615", 9), "18,446,744,073.7095");
});

test("the card shows the logo, the amount in Quote units and the crew number", async () => {
  const record = receipt({ logo: await greenLogo() });
  const svg = renderPresaleReceiptSvg(record, "card");
  assert.match(svg, />2,500</);
  assert.match(svg, />USDC</);
  assert.match(svg, />#1042</);
  assert.match(svg, />CREW NO\.</);
  assert.match(svg, />\$FROGGY</);
  assert.match(svg, />FROGGY</i);
  assert.match(svg, /MISSION CONTROL/);
  assert.ok(svg.includes(`data:image/png;base64,${record.logo!.bytes}`));
  assert.doesNotMatch(svg, /monogram/);

  const image = await renderPresaleReceiptPng(record, "card");
  assert.equal(image.contentType, "image/png");
  const metadata = await sharp(image.bytes).metadata();
  assert.deepEqual([metadata.format, metadata.width, metadata.height], ["png", CARD_PNG_WIDTH, CARD_PNG_HEIGHT]);
  assert.deepEqual([image.width, image.height], [2100, 1500]);
  // The monitor's centre is the coin logo's green.
  const [red, green, blue] = await pixel(image.bytes, 584, 712);
  assert.ok(green > 150 && red < 90 && blue < 90, `monitor centre ${red},${green},${blue}`);
});

test("a wallet without a crew shows no crew number", () => {
  const svg = renderPresaleReceiptSvg(receipt({ crew: null }), "card");
  assert.doesNotMatch(svg, /CREW NO\./);
  assert.doesNotMatch(svg, />#\d+</);
  assert.match(svg, />2,500</);
});

test("without a logo the monitor shows the coin's monogram mark", async () => {
  const record = receipt({ logo: null });
  const svg = renderPresaleReceiptSvg(record, "card");
  assert.match(svg, /id="pr-monogram"/);
  assert.match(svg, />FR</);
  assert.doesNotMatch(svg, /data:image\/png;base64/);
  const image = await renderPresaleReceiptPng(record, "card");
  const [red, green, blue] = await pixel(image.bytes, 584, 712);
  assert.ok(!(green > 150 && red < 90 && blue < 90), "no logo colour without a logo");
});

test("coin text is escaped, never markup", () => {
  const svg = renderPresaleReceiptSvg(receipt({ coinName: "<script>&", coinSymbol: "A<B" }), "card");
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;&amp;/);
});

test("the post format is the 1200x675 X layout with the same facts", async () => {
  const record = receipt({ logo: await greenLogo() });
  const svg = renderPresaleReceiptSvg(record, "share");
  assert.match(svg, /^<svg[^>]+width="1200" height="675"/);
  assert.match(svg, />2,500 USDC</);
  assert.match(svg, /Crew #1042/);
  const image = await renderPresaleReceiptPng(record, "share");
  const metadata = await sharp(image.bytes).metadata();
  assert.deepEqual([metadata.width, metadata.height], [CARD_SHARE_WIDTH, CARD_SHARE_HEIGHT]);
  assert.deepEqual([image.width, image.height], [1200, 675]);
});

test("the same record renders byte-identical PNGs", async () => {
  const record = receipt({ logo: await greenLogo() });
  for (const format of ["card", "share"] as const) {
    const [first, second] = await Promise.all([
      renderPresaleReceiptPng(record, format),
      renderPresaleReceiptPng(createPresaleReceiptRecord(structuredClone(record)), format),
    ]);
    assert.ok(first.bytes.equals(second.bytes), format);
  }
});

test("receipt renderer inputs are pinned to the receipt renderer version", async () => {
  const hash = createHash("sha256");
  // Canonical ownership changes source imports, while the pixel goldens stay fixed.
  for (const [label, module] of [
    ["sui-ids.ts", "@blast/core/lib/sui/ids.ts"],
    ["presale-receipt.ts", "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts"],
    ["presale-receipt-svg.ts", "@blast/server/modules/mission-control/card-renderer/presale-receipt-svg.ts"],
    ["card-brand.ts", "@blast/core/modules/mission-control/card-renderer/card-brand.ts"],
    ["brand-paths.json", "@blast/core/modules/mission-control/card-renderer/brand-paths.json"],
    ["card-assets.ts", "@blast/server/lib/card-assets.ts"],
  ]) {
    hash.update(label).update(await readFile(new URL(import.meta.resolve(module))));
  }
  const fonts = dirname(cardAssetPath("fonts/Inter-Bold.ttf"));
  for (const file of (await readdir(fonts)).filter((name) => name.endsWith(".ttf")).sort()) {
    hash.update(file).update(await readFile(join(fonts, file)));
  }
  // The shared Sui ID pattern changes the validation source bytes. Receipt
  // acceptance and rendered SVG stay identical.
  assert.deepEqual(
    { fingerprint: hash.digest("hex"), version: PRESALE_RECEIPT_RENDERER_VERSION },
    { fingerprint: "559a8d3e19a9831a86f02d65e89f11e71e11d4a7e10ad6f38e2d5a8d61b11fbd", version: "presale-receipt-renderer/1" },
    "Receipt layout or renderer inputs changed. If rendered pixels can differ, bump " +
      "PRESALE_RECEIPT_RENDERER_VERSION (card-renderer/version.ts), then record the new fingerprint here.",
  );
});
