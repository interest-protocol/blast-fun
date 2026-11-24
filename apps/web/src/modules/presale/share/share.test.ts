import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

import { fixtureDetail } from "../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { createPresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { EMPTY_SALE_METADATA } from "@blast/core/modules/social/contracts/sales.ts";
import { cardAssetPath } from "@blast/server/lib/card-assets.ts";
import { presaleShareSvg, renderPresaleSharePng } from "@blast/server/modules/presale/share/image.ts";
import { presalePreviewUrl, presaleShareMetadata, presaleShareUrl, presaleXIntent } from "./metadata.ts";
import { presaleShareRevision } from "@blast/core/modules/presale/share/revision.ts";
import { createPresaleShareImageRoute } from "@blast/server/modules/presale/share/route.ts";

function testImageRoute(dependencies: Parameters<typeof createPresaleShareImageRoute>[0]) {
  const image = createPresaleShareImageRoute(dependencies);
  return (id: string) => image(new Request("https://blast.test/presale/" + id + "/share-image"), id, testClient());
}

const sale = fixtureDetail("mrdn").presale;
const absent = async () => ({ logo: null, transient: false });

test("the shared URL is the canonical sale page; its metadata overrides the generic site preview", () => {
  for (const metadata of [null, { ...EMPTY_SALE_METADATA, tagline: "Onchain FX on Sui" }]) {
    const record = { ...sale, metadata };
    const tags = presaleShareMetadata(record);
    const url = `${SITE_ORIGIN}/presale/${sale.presale_id}`;
    assert.equal(presaleShareUrl(sale.presale_id), url);
    assert.deepEqual(tags.alternates, { canonical: url });
    assert.deepEqual(tags.title, { absolute: "Meridian ($MRDN) · Blast" });
    assert.equal(tags.description, metadata?.tagline ?? "Explore Meridian's presale on Blast.");
    assert.deepEqual(tags.twitter, {
      card: "summary_large_image", title: "Meridian ($MRDN) · Blast", description: tags.description,
      site: "@blastdotfun", images: [{ url: `${url}/share-image?v=${presaleShareRevision(record)}`, alt: "Meridian presale on Blast" }],
    });
    assert.ok(tags.openGraph && "url" in tags.openGraph);
    assert.equal(tags.openGraph.url, presalePreviewUrl(record));
  }
});

test("new funding figures and artwork produce fresh share and image URLs while keeping the canonical destination", () => {
  const before = presaleShareMetadata(sale);
  const changes = [
    { ...sale, raised_atoms: (BigInt(sale.raised_atoms) + 1n).toString() },
    { ...sale, target_atoms: (BigInt(sale.target_atoms) + 1n).toString() },
    { ...sale, raised_usd: "200000.00" },
    { ...sale, quote_symbol: "SUI", quote_decimals: 9 },
    { ...sale, icon_url: "https://example.com/new-logo.png" },
    { ...sale, metadata: { ...EMPTY_SALE_METADATA, tagline: "New description" } },
    { ...sale, metadata: { ...EMPTY_SALE_METADATA, cover: { url: "https://example.com/cover.webp", width: 1536, height: 512 } } },
  ];
  assert.equal(presalePreviewUrl({ ...sale }), presalePreviewUrl(sale), "unchanged data has a stable revision");
  for (const record of changes) {
    const after = presaleShareMetadata(record);
    assert.notEqual(presaleXIntent(record), presaleXIntent(sale));
    assert.notDeepEqual(after.twitter, before.twitter);
    assert.deepEqual(after.alternates, before.alternates);
    const shared = new URL(new URL(presaleXIntent(record)).searchParams.get("url")!);
    assert.equal(shared.pathname, `/presale/${sale.presale_id}`);
    assert.match(shared.searchParams.get("share")!, /^3-[a-f0-9]{16}$/);
  }
});

test("default cards render PNGs without artwork and safely display long or hostile names", async () => {
  const fallback = { logo: null, cover: null };
  const svg = presaleShareSvg({ ...sale, name: '<script>&"' + "long".repeat(50), symbol: "$MRDN", metadata: { ...EMPTY_SALE_METADATA, tagline: "x".repeat(80) } }, fallback);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;&amp;"));
  assert.ok(svg.includes(">$MRDN</text>"));
  assert.ok(svg.includes("textLength="));
  assert.ok(!svg.includes("NaN"));
  const bytes = await renderPresaleSharePng(sale, fallback);
  const image = await sharp(bytes).metadata();
  assert.deepEqual([image.format, image.width, image.height], ["png", 1200, 675]);
  assert.ok(bytes.length < 5 * 1024 * 1024);
  const logo = createPresaleReceiptLogo(await sharp({ create: { width: 64, height: 32, channels: 4, background: "#ff4c98" } }).png().toBuffer());
  const branded = await renderPresaleSharePng(sale, { logo, cover: logo });
  assert.notDeepEqual(branded, bytes, "the project's artwork reaches the actual raster output");
});

test("wide project names, tickers and taglines stay inside the card's text column", () => {
  const svg = presaleShareSvg({
    ...sale, name: "W".repeat(15), symbol: "W".repeat(20),
    metadata: { ...EMPTY_SALE_METADATA, tagline: "W".repeat(40) },
  }, { logo: null, cover: null });
  const texts = [...svg.matchAll(/<text[^>]*x="486"[^>]*>[^<]*<\/text>/g)];
  assert.ok(texts.length >= 4);
  for (const [text] of texts) {
    const bounds = new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="675">${text}</svg>`, {
      font: { loadSystemFonts: false, fontFiles: [cardAssetPath("fonts/Inter-ExtraBold.ttf")] },
    }).getBBox();
    assert.ok(bounds && bounds.x + bounds.width <= 1136, `Text overflowed the card: ${text}`);
  }
});

test("share cards show raised and target amounts in the sale's currency with exact funding progress", () => {
  const artwork = { logo: null, cover: null };
  const usd = presaleShareSvg(sale, artwork);
  assert.ok(usd.includes(">184,221 USDC / 250,000 USDC</text>"));
  assert.ok(usd.includes(">73.68%</text>"));
  const filledWidth = Number(usd.match(/width="([\d.]+)" height="12"[^>]*fill="#FF/i)?.[1]);
  assert.ok(Math.abs(filledWidth - 478.92) < 0.01);
  const sui = { ...sale, quote_symbol: "SUI", quote_decimals: 9, raised_atoms: "125500000000", target_atoms: "250000000000" };
  const native = presaleShareSvg(sui, artwork);
  assert.ok(native.includes(">125.5 SUI / 250 SUI</text>"));
  assert.ok(native.includes(">50.20%</text>"));
  for (const [raised, target, percentage, width] of [
    ["0", "1000", "0.00%", "0"],
    ["1001", "1000", "100.10%", "650"],
    ["1000001", "1000000", ">100%", "650"],
    ["0", "0", "–", "0"],
  ] as const) {
    const svg = presaleShareSvg({ ...sui, raised_atoms: raised, target_atoms: target }, artwork);
    assert.ok(svg.includes(`>${percentage.replace(">", "&gt;")}</text>`));
    assert.ok(svg.includes(`width="${width}" height="12"`));
    assert.ok(!svg.includes("NaN"));
  }
});

test("image route serves only real sales, uses current metadata and coalesces duplicate renders", async () => {
  let reads = 0;
  let renders = 0;
  let current = sale;
  const route = testImageRoute({
    readSale: async () => { reads++; return current; },
    logo: absent, cover: absent,
    render: async (record) => { renders++; return Buffer.from(record.name); },
  });
  assert.equal((await route("bad")).status, 404);
  assert.equal(reads, 0);
  const responses = await Promise.all([route(sale.presale_id), route(sale.presale_id)]);
  assert.equal(renders, 1);
  assert.equal(responses[0]!.headers.get("content-type"), "image/png");
  assert.equal(responses[0]!.headers.get("cache-control"), "private, no-store");
  assert.equal(await responses[0]!.text(), sale.name);
  await route(sale.presale_id);
  assert.equal(renders, 1);
  current = { ...sale, name: "Updated name" };
  assert.equal(await (await route(sale.presale_id)).text(), "Updated name");
  assert.equal(renders, 2);
  current = { ...current, raised_atoms: (BigInt(current.raised_atoms) + 1n).toString() };
  await route(sale.presale_id);
  assert.equal(renders, 3, "new commitments refresh the card immediately");
  const missing = testImageRoute({ readSale: async () => null, logo: absent, cover: absent, render: async () => { throw new Error("unreachable"); } });
  assert.equal((await missing(sale.presale_id)).status, 404);
});

test("an image failure logs a safe label without the provider message or payload", async (t) => {
  const previous = process.env.MISSION_CONTROL_METRICS;
  process.env.MISSION_CONTROL_METRICS = "on";
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_CONTROL_METRICS;
    else process.env.MISSION_CONTROL_METRICS = previous;
  });
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  const rawErrors = t.mock.method(console, "error", () => {});
  const route = testImageRoute({
    readSale: async () => { throw new Error("https://provider/?token=private-provider-token"); },
    logo: absent, cover: absent, render: async () => Buffer.from("unreachable"),
  });
  const response = await route(sale.presale_id);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(rawErrors.mock.callCount(), 0);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).metric, "presale.share_image.failed");
  assert.equal(JSON.parse(lines[0]!).error, "Error");
  assert.doesNotMatch(lines.join(""), /private-provider-token|https:\/\/provider/);
});

test("a transient artwork failure retries, and a busy renderer sheds excess work", { timeout: 5_000 }, async () => {
  let renders = 0;
  let finish: (() => void) | undefined;
  const route = testImageRoute({
    readSale: async () => sale,
    logo: async () => ({ logo: null, transient: true }), cover: absent,
    render: async () => { renders++; await new Promise<void>((resolve) => { finish = resolve; }); return Buffer.from("png"); },
  });
  const first = route(sale.presale_id);
  await new Promise((resolve) => setImmediate(resolve));
  const busy = await route(`0x${"b".repeat(64)}`);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "5");
  finish!();
  assert.equal((await first).status, 200);
  const retry = route(sale.presale_id);
  await new Promise((resolve) => setImmediate(resolve));
  finish!();
  await retry;
  assert.equal(renders, 2);
});
