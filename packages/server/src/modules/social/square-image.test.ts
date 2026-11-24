import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { CREATE_LOGO_FOLDER, CREATE_LOGO_IMAGE } from "@blast/server/modules/social/create/logo.ts";
import { PROFILE_PICTURE_IMAGE } from "@blast/server/modules/social/profile-edit/picture.ts";
import { PROFILE_PICTURE_FOLDER } from "@blast/server/modules/social/profile-edit/store.ts";
import { sanitizeSquareImage, squareImagePath, storeSquareImage } from "@blast/server/modules/social/square-image.ts";

test("UI-99: one square-image pipeline, each use with its own limits (picture 400 px, logo 512 px)", async () => {
  const { default: sharp } = await import("sharp");
  const jpeg = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#d61b70" } })
    .withMetadata({ exif: { IFD0: { Artist: "someone" } } }).jpeg().toBuffer();
  for (const [limits, side] of [[PROFILE_PICTURE_IMAGE, 400], [CREATE_LOGO_IMAGE, 512]] as const) {
    const result = await sanitizeSquareImage(jpeg, "image/jpeg", limits);
    assert.ok(result.ok);
    assert.equal(result.contentType, "image/webp");
    const meta = await sharp(result.bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height, meta.exif], ["webp", side, side, undefined]);
    // The same refusals and reasons for both uses.
    assert.deepEqual(await sanitizeSquareImage(jpeg, "image/png", limits), { ok: false, reason: "type" });
    assert.deepEqual(await sanitizeSquareImage(jpeg, null, limits), { ok: false, reason: "type" });
    assert.deepEqual(await sanitizeSquareImage(Buffer.from("<svg/>"), "image/svg+xml", limits), { ok: false, reason: "type" });
    assert.deepEqual(await sanitizeSquareImage(Buffer.alloc(0), "image/jpeg", limits), { ok: false, reason: "type" });
    assert.deepEqual(await sanitizeSquareImage(Buffer.alloc(limits.maxBytes + 1, 0xff), "image/jpeg", limits), { ok: false, reason: "type" });
    const tiny = await sharp({ create: { width: 63, height: 200, channels: 3, background: "#fff" } }).png().toBuffer();
    assert.deepEqual(await sanitizeSquareImage(tiny, "image/png", limits), { ok: false, reason: "dimensions" });
    const broken = Buffer.concat([jpeg.subarray(0, 64), Buffer.alloc(64)]);
    assert.deepEqual(await sanitizeSquareImage(broken, "image/jpeg", limits), { ok: false, reason: "undecodable" });
    const stillWebp = await sharp({ create: { width: 80, height: 80, channels: 4, background: "#fff" } }).webp().toBuffer();
    assert.ok((await sanitizeSquareImage(stillWebp, "image/webp", limits)).ok);
  }
});

test("UI-99: a stored square is content addressed under its use's folder; a failing or non-https store answers null", async () => {
  const bytes = Buffer.from("pixels");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const writes: string[] = [];
  const store = { write: async (path: string) => { writes.push(path); return { url: `https://blob.example/${path}` }; } };
  assert.equal(await storeSquareImage(store as never, PROFILE_PICTURE_FOLDER, { bytes, contentType: "image/webp" }), `https://blob.example/social-pictures/${sha}.webp`);
  assert.equal(await storeSquareImage(store as never, CREATE_LOGO_FOLDER, { bytes, contentType: "image/webp" }), `https://blob.example/create-logos/${sha}.webp`);
  assert.deepEqual(writes, [`social-pictures/${sha}.webp`, `create-logos/${sha}.webp`]);
  assert.equal(squareImagePath("create-logos", "ab"), "create-logos/ab.webp");
  const failing = { write: async () => { throw new Error("down"); } };
  assert.equal(await storeSquareImage(failing as never, PROFILE_PICTURE_FOLDER, { bytes, contentType: "image/webp" }), null);
  const plain = { write: async () => ({ url: "http://blob.example/x.webp" }) };
  assert.equal(await storeSquareImage(plain as never, CREATE_LOGO_FOLDER, { bytes, contentType: "image/webp" }), null);
});
