import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { EMPTY_SALE_METADATA, SALE_COVER_MAX_BYTES, SALE_METADATA_FIELDS, hasSaleMetadata } from "@blast/core/modules/social/contracts/sales.ts";
import { sanitizeSquareImage } from "@blast/server/modules/social/square-image.ts";
import { SALE_COVER_IMAGE, readCoverUpload, saleCoverFolder, storeCover } from "@blast/server/modules/social/sales/cover.ts";
import { presaleCapEditor, type SaleEditorFullnode } from "@blast/server/modules/social/sales/editor.ts";
import { changedFields, removeOperatorCover } from "./operator.ts";
import { EMPTY_STORED_SALE_METADATA, publicSaleMetadata, storedFromBefore } from "@blast/server/modules/social/sales/store.ts";
import {
  bareTelegram,
  bareXHandle,
  normalizeSaleLink,
  normalizeSaleMetadata,
  normalizeSaleTagline,
  normalizeTelegram,
  normalizeXHandle,
  saleLinkLabel,
} from "@blast/core/modules/social/sales/validate.ts";

/** R3-24: the sale details' validator, cover pipeline, editor check and operator helpers, without a database. */

const PRESALE = `0x${"ab".repeat(32)}`;

test("R3-24-AC-3: the tagline is the why-validator's text with 120 code points: blank clears, a newline, a link and length are refused", () => {
  assert.deepEqual(normalizeSaleTagline("  Café for the long run  "), { ok: true, value: "Café for the long run" });
  assert.deepEqual(normalizeSaleTagline(" \t "), { ok: true, value: null });
  const karesDescription = "A tactical MMORPG protocol on Sui. Explore on-chain worlds, fight monsters, beat dungeons, and trade your loot.";
  assert.deepEqual(normalizeSaleTagline(karesDescription), { ok: true, value: karesDescription });
  assert.deepEqual(normalizeSaleTagline("\u{1F680}".repeat(120)), { ok: true, value: "\u{1F680}".repeat(120) });
  assert.deepEqual(normalizeSaleTagline("a".repeat(121)), { ok: false, code: "tagline_too_long" });
  assert.deepEqual(normalizeSaleTagline("b".repeat(300)), { ok: false, code: "tagline_too_long" });
  assert.deepEqual(normalizeSaleTagline("The best launch on blast.fun"), { ok: false, code: "tagline_has_link" });
  assert.deepEqual(normalizeSaleTagline("see https://x.example"), { ok: false, code: "tagline_has_link" });
  assert.deepEqual(normalizeSaleTagline("one\ntwo"), { ok: false, code: "tagline_invalid" });
  assert.deepEqual(normalizeSaleTagline("tab\there"), { ok: false, code: "tagline_invalid" });
  // v2.0 is not a link (its last label is a digit), as in a why.
  assert.deepEqual(normalizeSaleTagline("Lending v2.0, on Sui"), { ok: true, value: "Lending v2.0, on Sui" });
});

test("R3-24-AC-3: a link is http(s), no userinfo, no port, a DNS name, stored as https://<host>[/<path>]", () => {
  const ok = (input: string, value: string | null) => assert.deepEqual(normalizeSaleLink(input), { ok: true, value }, input);
  const bad = (input: string) => assert.deepEqual(normalizeSaleLink(input), { ok: false }, input);
  ok("", null);
  ok("   ", null);
  ok("meridian.finance", "https://meridian.finance");
  ok("Meridian.Finance/Docs", "https://meridian.finance/Docs");
  ok("http://meridian.finance/", "https://meridian.finance");
  ok("https://www.meridian.finance/a/b?c=1#frag", "https://www.meridian.finance/a/b?c=1");
  ok("https://meridian.finance/?ref=blast", "https://meridian.finance/?ref=blast");
  ok("https://medium.com/@meridian/launch", "https://medium.com/@meridian/launch");
  ok("https://bücher.example/x", "https://xn--bcher-kva.example/x");
  bad("ftp://x");
  bad("ftp://files.meridian.finance/report.pdf");
  bad("https://user@host.example");
  bad("https://user:pw@host.example");
  bad("https://meridian.finance:8443/x");
  bad("https://meridian.finance:443/x");
  bad("meridian.finance:8080");
  bad("http://127.0.0.1/x");
  bad("https://[::1]/");
  bad("http://localhost:3000");
  bad("localhost");
  bad("javascript:alert(1)");
  bad("mailto:team@meridian.finance");
  bad("data:text/html,hi");
  bad("not a link");
  bad("meridian");
  bad(`https://meridian.finance/${"a".repeat(600)}`);
  assert.equal(saleLinkLabel("https://www.meridian.finance/"), "meridian.finance");
  assert.equal(saleLinkLabel("https://docs.meridian.finance/intro"), "docs.meridian.finance/intro");
});

test("R3-24-AC-3: X and Telegram are bare handles; a pasted URL or @ is reduced, a wrong length refused", () => {
  assert.deepEqual(normalizeXHandle("https://x.com/@meridianfx"), { ok: true, value: "meridianfx" });
  assert.deepEqual(normalizeXHandle("x.com/meridianfx"), { ok: true, value: "meridianfx" });
  assert.deepEqual(normalizeXHandle("https://twitter.com/Meridian_FX?s=20"), { ok: true, value: "Meridian_FX" });
  assert.deepEqual(normalizeXHandle("@meridianfx"), { ok: true, value: "meridianfx" });
  assert.deepEqual(normalizeXHandle(""), { ok: true, value: null });
  assert.deepEqual(normalizeXHandle("a".repeat(15)), { ok: true, value: "a".repeat(15) });
  assert.deepEqual(normalizeXHandle("a".repeat(16)), { ok: false });
  assert.deepEqual(normalizeXHandle("meridian.fx"), { ok: false });
  assert.deepEqual(normalizeTelegram("https://t.me/meridianfx"), { ok: true, value: "meridianfx" });
  assert.deepEqual(normalizeTelegram("t.me/meridianfx"), { ok: true, value: "meridianfx" });
  assert.deepEqual(normalizeTelegram("telegram.me/meridianfx"), { ok: true, value: "meridianfx" });
  assert.deepEqual(normalizeTelegram("@meridianfx"), { ok: true, value: "meridianfx" });
  assert.deepEqual(normalizeTelegram("abcd"), { ok: false });
  assert.deepEqual(normalizeTelegram("abcde"), { ok: true, value: "abcde" });
  assert.deepEqual(normalizeTelegram("a".repeat(33)), { ok: false });
  assert.equal(bareXHandle(" @mira "), "mira");
  assert.equal(bareTelegram("https://t.me/blastfun/12"), "blastfun");
});

test("R3-24-AC-3 / AC-7: a request's fields are normalized in field order; a non-string value is invalid, an absent key unchanged", () => {
  assert.deepEqual(normalizeSaleMetadata({}), { ok: true, values: {} });
  assert.deepEqual(normalizeSaleMetadata({ tagline: null, site: "", x_handle: "https://x.com/@meridianfx" }), {
    ok: true,
    values: { tagline: null, site: null, x_handle: "meridianfx" },
  });
  assert.deepEqual(normalizeSaleMetadata({ tagline: 5 }), { ok: false, invalid: true });
  assert.deepEqual(normalizeSaleMetadata({ site: ["x"] }), { ok: false, invalid: true });
  assert.deepEqual(normalizeSaleMetadata({ site: "ftp://x", tagline: "on blast.fun" }), { ok: false, refusal: { code: "tagline_has_link", field: "tagline" } });
  assert.deepEqual(normalizeSaleMetadata({ audit_url: "https://user@host.example" }), { ok: false, refusal: { code: "invalid_link", field: "audit_url" } });
  assert.deepEqual(normalizeSaleMetadata({ x_handle: "a".repeat(16) }), { ok: false, refusal: { code: "invalid_x_handle", field: "x_handle" } });
  assert.deepEqual(normalizeSaleMetadata({ telegram: "abcd" }), { ok: false, refusal: { code: "invalid_telegram", field: "telegram" } });
  // The vocabulary is exactly the six fields: no term of the sale is one of them.
  assert.deepEqual([...SALE_METADATA_FIELDS], ["tagline", "site", "x_handle", "telegram", "docs_url", "audit_url"]);
});

test("R3-24-AC-7: the published request schema is closed and names no term; the details schema matches the empty shape", () => {
  const validator = createSocialValidator();
  assert.deepEqual(validator.validate("sale-metadata-request", { tagline: "x", site: null }).errors, []);
  for (const term of ["raise_target", "target", "wallet_cap", "min_commitment", "vesting", "quote_type", "venue", "launch_at_ms", "cover_key"]) {
    assert.equal(validator.validate("sale-metadata-request", { [term]: "1" }).valid, false, term);
  }
  assert.deepEqual(validator.validate("sale-metadata", EMPTY_SALE_METADATA).errors, []);
  assert.deepEqual(validator.validate("sale-metadata-response", { presale_id: PRESALE, metadata: EMPTY_SALE_METADATA, editable: false }).errors, []);
  assert.equal(hasSaleMetadata(EMPTY_SALE_METADATA), false);
  assert.equal(hasSaleMetadata({ ...EMPTY_SALE_METADATA, telegram: "meridianfx" }), true);
  assert.equal(hasSaleMetadata({ ...EMPTY_SALE_METADATA, launch_at_ms: 1 }), true);
});

test("R3-24-AC-4: a cover of any accepted type is re-encoded to a 1536 × 512 WebP; an SVG, a tiny image and an oversized file are refused", async () => {
  const { default: sharp } = await import("sharp");
  const png = await sharp({ create: { width: 3_000, height: 1_000, channels: 3, background: "#d61b70" } }).png().toBuffer();
  const jpeg = await sharp({ create: { width: 900, height: 900, channels: 3, background: "#123456" } })
    .withMetadata({ exif: { IFD0: { Artist: "someone" } } }).jpeg().toBuffer();
  // Gap 17: a portrait photo the camera stored sideways (EXIF orientation 6) is measured as shown.
  const turned = await sharp({ create: { width: 1_200, height: 800, channels: 3, background: "#654321" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  for (const [bytes, type, source] of [
    [png, "image/png", { width: 3_000, height: 1_000 }],
    [jpeg, "image/jpeg", { width: 900, height: 900 }],
    [turned, "image/jpeg", { width: 800, height: 1_200 }],
  ] as const) {
    const result = await sanitizeSquareImage(bytes, type, SALE_COVER_IMAGE);
    assert.ok(result.ok, type);
    assert.deepEqual(result.source, source, "the upload's size, as shown");
    const meta = await sharp(result.bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["webp", 1_536, 512, undefined]);
  }
  assert.deepEqual(await sanitizeSquareImage(Buffer.from("<svg/>"), "image/svg+xml", SALE_COVER_IMAGE), { ok: false, reason: "type" });
  const tiny = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
  assert.deepEqual(await sanitizeSquareImage(tiny, "image/png", SALE_COVER_IMAGE), { ok: false, reason: "dimensions" });
  assert.deepEqual(await sanitizeSquareImage(Buffer.alloc(SALE_COVER_MAX_BYTES + 1, 0xff), "image/jpeg", SALE_COVER_IMAGE), { ok: false, reason: "type" });
});

test("R3-24: a cover is stored under the sale's own folder at its content address; a failing or non-https store answers null", async () => {
  const bytes = Buffer.from("pixels");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const writes: string[] = [];
  const store = { write: async (path: string) => { writes.push(path); return { url: `https://blob.example/${path}` }; } };
  const source = { width: 2_400, height: 800 };
  assert.deepEqual(await storeCover(store, saleCoverFolder(PRESALE), { bytes, contentType: "image/webp", source }), {
    key: `sale-covers/${PRESALE}/${sha}.webp`,
    url: `https://blob.example/sale-covers/${PRESALE}/${sha}.webp`,
    width: 1_536,
    height: 512,
    source,
  });
  assert.deepEqual(writes, [`sale-covers/${PRESALE}/${sha}.webp`]);
  assert.equal(await storeCover({ write: async () => { throw new Error("down"); } }, "f", { bytes, contentType: "image/webp", source }), null);
  assert.equal(await storeCover({ write: async () => ({ url: "http://blob.example/x" }) }, "f", { bytes, contentType: "image/webp", source }), null);
});

test("R3-24: a cover upload is one `cover` file in multipart/form-data; anything else is refused before decoding", async () => {
  // As a browser sends it: the encoded form with its boundary and its length.
  const upload = async (form: FormData | string, contentType?: string) => {
    const encoded = new Response(form);
    const encodedType = encoded.headers.get("content-type")!;
    const body = new Uint8Array(await encoded.arrayBuffer());
    const headers = { "content-type": contentType ?? encodedType, "content-length": String(body.byteLength) };
    return new Request("https://blast.fun/api/social/sales/x/cover", { method: "POST", body, headers });
  };
  const one = new FormData();
  one.set("cover", new File([new Uint8Array([1, 2, 3])], "c.png", { type: "image/png" }));
  assert.deepEqual(await readCoverUpload(await upload(one)), { bytes: new Uint8Array([1, 2, 3]), declared: "image/png" });
  const two = new FormData();
  two.append("cover", new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
  two.append("cover", new File([new Uint8Array([2])], "b.png", { type: "image/png" }));
  const text = new FormData();
  text.set("cover", "not a file");
  const named = new FormData();
  named.set("image", new File([new Uint8Array([1])], "a.png", { type: "image/png" }));
  for (const form of [two, text, named, new FormData()]) {
    await assert.rejects(readCoverUpload(await upload(form)), { code: "invalid_request" });
  }
  await assert.rejects(readCoverUpload(await upload("raw", "image/png")), { code: "invalid_request" });
  const big = new FormData();
  big.set("cover", new File([new Uint8Array(SALE_COVER_MAX_BYTES + 1)], "big.png", { type: "image/png" }));
  await assert.rejects(readCoverUpload(await upload(big)), { code: "body_too_large" });
  const huge = new FormData();
  huge.set("cover", new File([new Uint8Array(5 * 1_024 * 1_024)], "huge.png", { type: "image/png" }));
  await assert.rejects(readCoverUpload(await upload(huge)), { code: "body_too_large" });
});

/** A fullnode whose presale object names `cap` as its cap, owned by `owner`. */
function fullnode(capOwner: { $kind: string; AddressOwner?: string }, type = `0x${"76".repeat(32)}::blast_presale::Presale<0x2::a::A, 0x2::b::B>`) {
  const cap = `0x${"ca".repeat(32)}`;
  const calls: string[] = [];
  const node: SaleEditorFullnode = {
    async getObject({ objectId }) {
      calls.push(objectId);
      if (objectId === PRESALE) {
        const content = new Uint8Array(200);
        content.set(Buffer.from("ab".repeat(32), "hex"), 0);
        content.set(Buffer.from(cap.slice(2), "hex"), 32);
        return { object: { type, owner: { $kind: "Shared" }, content } };
      }
      if (objectId === cap) return { object: { type: `0x${"76".repeat(32)}::blast_presale::PresaleCap`, owner: capOwner } };
      throw new Error("not found");
    },
  };
  return { node, calls, cap };
}

test("R3-24: the editor is the wallet holding the sale's PresaleCap, read from the presale's second field; kept a minute", async () => {
  const wallet = `0x${"0".repeat(60)}beef`;
  let now = 0;
  const { node, calls, cap } = fullnode({ $kind: "AddressOwner", AddressOwner: "0xBEEF" });
  const editor = presaleCapEditor(() => node, { now: () => now, cacheMs: 60_000 });
  assert.equal(await editor(PRESALE), wallet);
  assert.deepEqual(calls, [PRESALE, cap]);
  now = 59_000;
  assert.equal(await editor(PRESALE), wallet);
  assert.equal(calls.length, 2, "kept");
  now = 61_000;
  assert.equal(await editor(PRESALE), wallet);
  assert.equal(calls.length, 4, "read again after a minute");
  // A shared, wrapped or object-owned cap has no editor; neither has an object that is not a presale.
  assert.equal(await presaleCapEditor(() => fullnode({ $kind: "Shared" }).node)(PRESALE), null);
  assert.equal(await presaleCapEditor(() => fullnode({ $kind: "ObjectOwner" }).node)(PRESALE), null);
  assert.equal(await presaleCapEditor(() => fullnode({ $kind: "AddressOwner", AddressOwner: "0x1" }, "0x2::coin::Coin<0x2::sui::SUI>").node)(PRESALE), null);
  // A failed read throws and is not kept.
  let fail = true;
  const flaky: SaleEditorFullnode = {
    async getObject(input) {
      if (fail) throw new Error("down");
      return fullnode({ $kind: "AddressOwner", AddressOwner: "0x1" }).node.getObject(input);
    },
  };
  const retried = presaleCapEditor(() => flaky);
  await assert.rejects(retried(PRESALE));
  fail = false;
  assert.equal(await retried(PRESALE), `0x${"0".repeat(63)}1`);
});

test("R3-24: an edit's `before` round-trips; the operator names changed fields only and deletes a removed cover's object", async () => {
  const stored = {
    ...EMPTY_STORED_SALE_METADATA,
    tagline: "Lending for the long run",
    x_handle: "meridianfx",
    launch_at_ms: 1_800_000_000_000,
    cover: {
      key: `sale-covers/${PRESALE}/${"1".repeat(64)}.webp`, url: "https://blob.example/c.webp", width: 1_536, height: 512,
      source: { width: 3_000, height: 1_000 },
    },
  };
  // The edit row's jsonb `before`: the stored fields, the cover flattened into its columns.
  const { cover, ...fields } = stored;
  const flat = { ...fields, cover_key: cover.key, cover_url: cover.url, cover_width: 1_536, cover_height: 512 };
  const json: unknown = { ...flat, cover_source_width: 3_000, cover_source_height: 1_000 };
  assert.deepEqual(storedFromBefore(json), stored);
  // An edit logged before 0137 has no upload size: the cover reads back without one.
  assert.deepEqual(storedFromBefore(flat), { ...stored, cover: { ...cover, source: null } });
  assert.equal(storedFromBefore({ tagline: 1 }), null);
  assert.equal(storedFromBefore(null), null);
  assert.deepEqual(changedFields(EMPTY_STORED_SALE_METADATA, stored), ["tagline", "x_handle", "launch_at_ms", "cover"]);
  // The same pixels uploaded again after 0137 add their size: the edit names the cover, never an empty change.
  assert.deepEqual(changedFields({ ...stored, cover: { ...cover, source: null } }, stored), ["cover"]);
  assert.deepEqual(changedFields(stored, { ...stored }), []);
  assert.deepEqual(publicSaleMetadata(stored).cover, {
    url: "https://blob.example/c.webp", width: 1_536, height: 512, source: { width: 3_000, height: 1_000 },
  });
  assert.deepEqual(createSocialValidator().validate("sale-metadata", publicSaleMetadata(stored)).errors, []);
  assert.equal(JSON.stringify(publicSaleMetadata(stored)).includes("sale-covers/"), false, "the key is never public");
  const removed: string[] = [];
  const store = { remove: async (url: string) => { removed.push(url); } };
  assert.equal(await removeOperatorCover({ removed_cover_url: "https://blob.example/c.webp" }, store), "removed");
  assert.deepEqual(removed, ["https://blob.example/c.webp"]);
  assert.equal(await removeOperatorCover({ removed_cover_url: null }, store), "none");
  assert.equal(await removeOperatorCover({ removed_cover_url: "https://blob.example/c.webp" }, null), "kept");
  assert.equal(await removeOperatorCover({ removed_cover_url: "https://x" }, { remove: async () => { throw new Error("down"); } }), "kept");
});
