import { publicCardSharePath } from "@blast/core/modules/mission-control/card-images/contracts.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "#web/test/css-design-px.ts";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { LRUCache } from "lru-cache";
import sharp from "sharp";

import { cardAssetPath } from "@blast/server/lib/card-assets.ts";
import { originalXAvatar, placeholderAvatar, snapshotApprovedXAvatar } from "@blast/server/lib/x-avatar.ts";
import { upgradeCardAvatar } from "@blast/server/modules/mission-control/card-images/avatar.ts";

import { CARD_RENDERER_VERSION, createApprovedXAvatarSnapshot, createSeasonZeroCardRecord, renderSeasonZeroCardPng, type SeasonZeroCardRecord } from "@blast/server/modules/mission-control/card-renderer/index.ts";
import { makeSeasonZeroCardFixtures } from "../../../../../../packages/server/test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
import { decideMissionControlRoute } from "@blast/core/lib/mission-control/route-policy.ts";
import { classifyBlobError, ByteLruCache, canonicalJson, CardImageBusyError, cardImageBody, cardImageIdentity, cardImagePathname, cardImageSettingsFromEnvironment, cardImageStore, CardImageService, FilesystemCardImageStore, PUBLIC_CARD_IMAGE_CACHE_CONTROL, canonicalCardImageRedirect, cardImageQuery, publicCardImagePath, publicCardImageResponse, renderCardImageWithSharp, VercelBlobCardImageStore, warmPublicCardImage, WARM_PUBLIC_CARD_IMAGE_BUDGET_MS, type BlobGet, type BlobPut, type CardImageCatalog, type CardImageFormat, type CardImageKey, type CardImageLocation, type CardImageRenderer, type CardImageStore } from "@blast/server/modules/mission-control/card-images/index.ts";

const [fixture] = await makeSeasonZeroCardFixtures();
const RECORD = fixture.record;

function publishedSnapshot(record: SeasonZeroCardRecord) {
  return { record, recruitHandles: [] as readonly string[], recruitTotal: 0 };
}

function cardRecord(cardId: string): SeasonZeroCardRecord {
  return createSeasonZeroCardRecord({ ...RECORD, cardId });
}

function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).reverse().map(([key, nested]) => [key, reversedKeys(nested)]),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function keyId(key: CardImageKey): string {
  return `${key.cardId}/${key.format}/${key.digest}`;
}

/** Rows keyed like the table's primary key; the first record wins, as with ON CONFLICT DO NOTHING. */
class FakeCatalog implements CardImageCatalog {
  readonly rows = new Map<string, CardImageLocation>();
  failFind: unknown = null;
  failRecord: unknown = null;
  finds = 0;
  records = 0;

  async find(key: CardImageKey): Promise<CardImageLocation | null> {
    this.finds += 1;
    if (this.failFind) throw this.failFind;
    return this.rows.get(keyId(key)) ?? null;
  }

  async record(key: CardImageKey, location: CardImageLocation): Promise<void> {
    this.records += 1;
    if (this.failRecord) throw this.failRecord;
    if (!this.rows.has(keyId(key))) this.rows.set(keyId(key), location);
  }
}

class FakeStore implements CardImageStore {
  readonly kind = "filesystem" as const;
  readonly objects = new Map<string, Buffer>();
  failRead: unknown = null;
  failWrite: unknown = null;
  reads = 0;
  writes = 0;

  async read(pathname: string): Promise<Buffer | null> {
    this.reads += 1;
    if (this.failRead) throw this.failRead;
    return this.objects.get(pathname) ?? null;
  }

  async write(pathname: string, bytes: Buffer): Promise<{ url: string }> {
    this.writes += 1;
    if (this.failWrite) throw this.failWrite;
    this.objects.set(pathname, Buffer.from(bytes));
    return { url: `memory://${pathname}` };
  }
}

function countingRenderer(delayMs = 25) {
  const calls: string[] = [];
  const render: CardImageRenderer = async (record, format) => {
    calls.push(`${record.cardId}/${format}`);
    await sleep(delayMs);
    return Buffer.from(`png:${record.cardId}:${format}`);
  };
  return { calls, render };
}

function persistedService(
  render: CardImageRenderer,
  persistence = { catalog: new FakeCatalog(), store: new FakeStore() },
  options: Partial<{ memoryCacheBytes: number }> = {},
) {
  const service = new CardImageService({
    memoryCacheBytes: options.memoryCacheBytes ?? 1024 * 1024,
    persistence,
    render,
  });
  return { ...persistence, service };
}

function captureMetrics(t: TestContext) {
  const info = t.mock.method(console, "info", () => {});
  return () => info.mock.calls.map((call) =>
    JSON.parse(String(call.arguments[0])) as Record<string, unknown>);
}

test("digests ignore key order and JSONB round trips but change with every rendered field", async () => {
  const { digest, record } = cardImageIdentity(RECORD);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(record.cardId, RECORD.cardId);
  assert.equal(cardImageIdentity(reversedKeys(RECORD)).digest, digest);
  assert.equal(cardImageIdentity(structuredClone(RECORD)).digest, digest);
  // The digest names the normalized record the renderer draws, not the raw input.
  assert.equal(cardImageIdentity({ ...RECORD, callsign: ` @${RECORD.callsign} ` }).digest, digest);
  const stats = { recruitHandles: ["dobychamp"], recruitTotal: 1 };
  assert.notEqual(cardImageIdentity(RECORD, stats).digest, digest);
  assert.notEqual(
    cardImageIdentity(RECORD, stats).digest,
    cardImageIdentity(RECORD, { recruitHandles: ["0xPain__"], recruitTotal: 1 }).digest,
  );
  assert.equal(
    digest,
    createHash("sha256")
      .update(canonicalJson({ record: createSeasonZeroCardRecord(RECORD), renderer: CARD_RENDERER_VERSION }))
      .digest("hex"),
  );

  const otherAvatar = createApprovedXAvatarSnapshot(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
  );
  const variants = [
    { ...RECORD, callsign: "other_callsign" },
    { ...RECORD, crew: RECORD.crew + 1 },
    { ...RECORD, title: "CAPCOM" },
    { ...RECORD, avatar: otherAvatar },
    { ...RECORD, cardId: "fixture-crew-other" },
  ];
  const digests = new Set([digest, ...variants.map((variant) => cardImageIdentity(variant).digest)]);
  assert.equal(digests.size, variants.length + 1);

  assert.throws(() => cardImageIdentity({ ...RECORD, avatar: { ...RECORD.avatar, sha256: "0".repeat(64) } }));
  assert.equal(
    cardImagePathname({ cardId: RECORD.cardId, digest, format: "share" }),
    `mission-control/cards/${RECORD.cardId}/share-${digest}.png`,
  );
});

test("canonical JSON sorts keys at every depth and refuses values JSON cannot keep", () => {
  assert.equal(
    canonicalJson({ b: [{ z: 1, a: "x" }], a: { d: null, c: true }, skipped: undefined }),
    '{"a":{"c":true,"d":null},"b":[{"a":"x","z":1}]}',
  );
  assert.throws(() => canonicalJson(Number.NaN), TypeError);
  assert.throws(() => canonicalJson(undefined), TypeError);
});

test("renderer inputs are pinned to the renderer version", async () => {
  const hash = createHash("sha256");
  for (const [label, module] of [
    ["edition-artwork.cjs", "@blast/server/modules/mission-control/card-renderer/edition-artwork.cjs"],
    ["brand-paths.json", "@blast/core/modules/mission-control/card-renderer/brand-paths.json"],
    ["svg.ts", "@blast/server/modules/mission-control/card-renderer/svg.ts"],
    ["render.ts", "@blast/server/modules/mission-control/card-renderer/render.ts"],
    ["@blast/server/modules/mission-control/card-images/avatar.ts", "@blast/server/modules/mission-control/card-images/avatar.ts"],
    ["@blast/server/lib/x-avatar.ts", "@blast/server/lib/x-avatar.ts"],
    ["x-photo-url.ts", "@blast/core/lib/x-photo-url.ts"],
    ["card-assets.ts", "@blast/server/lib/card-assets.ts"],
  ]) {
    hash.update(label).update(await readFile(new URL(import.meta.resolve(module))));
  }
  const editions = dirname(cardAssetPath("editions/bronze.png"));
  for (const file of (await readdir(editions)).sort()) {
    hash.update(file).update(await readFile(join(editions, file)));
  }
  const fonts = dirname(cardAssetPath("fonts/Inter-Bold.ttf"));
  for (const file of (await readdir(fonts)).filter((file) => file.endsWith(".ttf")).sort()) {
    hash.update(file).update(await readFile(join(fonts, file)));
  }
  assert.deepEqual(
    { fingerprint: hash.digest("hex"), version: CARD_RENDERER_VERSION },
    {
      fingerprint: "08413038a7a1c64c728cb40eb0f52db32965ab47edae18b34026dcf2829080d1",
      version: "season-zero-card-renderer/8",
    },
    "Card artwork or renderer inputs changed. If rendered pixels can differ, bump " +
      "CARD_RENDERER_VERSION (card-renderer/version.ts) so persisted images are re-rendered, " +
      "then record the new fingerprint and version here.",
  );
});

async function avatarBytes(size: number) {
  return sharp({ create: { width: size, height: size, channels: 3, background: "#e99bc4" } })
    .png().toBuffer();
}

function avatarResponse(bytes: Buffer) {
  return new Response(new Uint8Array(bytes), { headers: { "content-type": "image/png" } });
}

const X_AVATAR = "https://pbs.twimg.com/profile_images/123/pilot_normal.png";

test("new claims snapshot the original X portrait instead of the provider thumbnail", async () => {
  const bytes = await avatarBytes(400);
  for (const suffix of ["normal", "bigger", "mini", "200x200", "400x400"]) {
    const avatar = await snapshotApprovedXAvatar(X_AVATAR.replace("normal", suffix), async (input, init) => {
      assert.equal(String(input), X_AVATAR.replace("_normal", ""));
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.ok(init?.signal);
      return avatarResponse(bytes);
    });
    assert.equal(avatar.bytesBase64, bytes.toString("base64"));
  }
});

test("an account with X's stock silhouette snapshots the abs.twimg.com default image", async () => {
  const bytes = await avatarBytes(48);
  const reference = "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png";
  const avatar = await snapshotApprovedXAvatar(reference, async (input) => {
    assert.equal(String(input), reference.replace("_normal", ""));
    return avatarResponse(bytes);
  });
  assert.equal(avatar.bytesBase64, bytes.toString("base64"));
});

test("no X photo, or one X has deleted, claims with the Blast pilot placeholder", async () => {
  const placeholder = await placeholderAvatar();
  assert.equal(placeholder.mediaType, "image/png");
  const { default: sharp } = await import("sharp");
  const size = await sharp(Buffer.from(placeholder.bytesBase64, "base64")).metadata();
  assert.deepEqual({ width: size.width, height: size.height }, { width: 512, height: 512 });

  const neverFetch: typeof fetch = async () => { throw new Error("Must not fetch"); };
  assert.deepEqual(await snapshotApprovedXAvatar(null, neverFetch), placeholder);

  const gone: typeof fetch = async () => new Response(null, { status: 404 });
  assert.deepEqual(await snapshotApprovedXAvatar(X_AVATAR, gone), placeholder);
});

test("avatar downloads enforce the host, media, and streamed byte limits", async () => {
  const neverFetch: typeof fetch = async () => { throw new Error("Must not fetch"); };
  for (const reference of ["https://example.com/a.png", "https://pbs.twimg.com.evil.test/a.png", "https://user:password@pbs.twimg.com/a.png"]) {
    await assert.rejects(snapshotApprovedXAvatar(reference, neverFetch), (error: Error & { code?: string }) =>
      /not approved/.test(error.message) && error.code === "AVATAR_HOST_NOT_APPROVED");
  }
  await assert.rejects(snapshotApprovedXAvatar(X_AVATAR, async () =>
    new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })), /snapshotted/);
  await assert.rejects(snapshotApprovedXAvatar(X_AVATAR, async () =>
    avatarResponse(Buffer.alloc(5_000_001))), /snapshot limit/);
  await assert.rejects(snapshotApprovedXAvatar(X_AVATAR, async () =>
    new Response(null, { status: 503 })), /snapshotted/);
  await assert.rejects(snapshotApprovedXAvatar(X_AVATAR, async () =>
    { throw new Error("timeout"); }), /timeout/);
});

test("a photo X serves only at 400 px snapshots that size, not the thumbnail", async () => {
  const bytes = await avatarBytes(400);
  const sized = X_AVATAR.replace("_normal", "_400x400");
  const requested: string[] = [];
  const avatar = await snapshotApprovedXAvatar(X_AVATAR, async (url) => {
    requested.push(String(url));
    return String(url) === sized ? avatarResponse(bytes) : new Response(null, { status: 404 });
  });
  assert.deepEqual(requested, [X_AVATAR.replace("_normal", ""), sized]);
  assert.equal(avatar.bytesBase64, bytes.toString("base64"));
});

test("only a permanently missing original falls back to the provider thumbnail", async () => {
  const bytes = await avatarBytes(48);
  const requested: string[] = [];
  const avatar = await snapshotApprovedXAvatar(X_AVATAR, async (url) => {
    requested.push(String(url));
    return String(url) === X_AVATAR ? avatarResponse(bytes) : new Response(null, { status: 404 });
  });
  assert.deepEqual(requested, [X_AVATAR.replace("_normal", ""), X_AVATAR.replace("_normal", "_400x400"), X_AVATAR]);
  assert.equal(avatar.bytesBase64, bytes.toString("base64"));
  assert.equal(await originalXAvatar(X_AVATAR, async () => new Response(null, { status: 410 })), null);
});

test("all fourteen editions recover legacy 48px portraits without changing claimed identity", async () => {
  const thumbnail = createApprovedXAvatarSnapshot(await avatarBytes(48), "image/png");
  const original = await avatarBytes(400);
  for (const { record } of await makeSeasonZeroCardFixtures()) {
    const legacy = createSeasonZeroCardRecord({ ...record, avatar: thumbnail });
    const upgraded = await upgradeCardAvatar(legacy, async (id) => {
      assert.equal(id, legacy.cardId);
      return X_AVATAR;
    }, async () => avatarResponse(original));
    assert.deepEqual(upgraded, createSeasonZeroCardRecord({
      ...legacy, avatar: createApprovedXAvatarSnapshot(original, "image/png"),
    }));
    assert.equal(legacy.avatar.sha256, thumbnail.sha256);
    assert.equal((await sharp(Buffer.from(upgraded.avatar.bytesBase64, "base64")).metadata()).width, 400);
    assert.equal(await upgradeCardAvatar(upgraded, async () => { throw new Error("No lookup needed"); }), upgraded);
  }
  const legacy = createSeasonZeroCardRecord({ ...RECORD, avatar: thumbnail });
  assert.equal(await upgradeCardAvatar(legacy, async () => null), legacy);
  assert.equal(await upgradeCardAvatar(legacy, async () => X_AVATAR,
    async () => new Response(null, { status: 404 })), legacy);
  assert.equal(await upgradeCardAvatar(legacy, async () => X_AVATAR,
    async () => avatarResponse(await avatarBytes(24))), legacy);
});

test("recovered portraits reach both cached image formats and transient failures remain retryable", async (t) => {
  captureMetrics(t);
  const legacy = createSeasonZeroCardRecord({
    ...RECORD, avatar: createApprovedXAvatarSnapshot(await avatarBytes(48), "image/png"),
  });
  const original = await avatarBytes(400);
  const expected = createSeasonZeroCardRecord({
    ...RECORD, avatar: createApprovedXAvatarSnapshot(original, "image/png"),
  });
  let unavailable = true;
  let downloads = 0;
  const renderer: CardImageRenderer = async (record, format) => renderCardImageWithSharp(
    await upgradeCardAvatar(record, async () => X_AVATAR, async () => {
      downloads++;
      return unavailable ? new Response(null, { status: 503 }) : avatarResponse(original);
    }), format,
  );
  const persistence = { catalog: new FakeCatalog(), store: new FakeStore() };
  const { service } = persistedService(renderer, persistence, { memoryCacheBytes: 16 * 1024 * 1024 });
  await assert.rejects(service.image({ record: legacy, format: "card" }), /snapshotted/);
  assert.equal(persistence.store.writes, 0);
  unavailable = false;
  for (const format of ["card", "share"] as const) {
    const result = await service.image({ record: legacy, format });
    assert.deepEqual(result.bytes, await renderCardImageWithSharp(expected, format));
    assert.equal((await service.image({ record: legacy, format })).source, "memory");
    const fresh = persistedService(async () => { throw new Error("Must use persisted repair"); }, persistence);
    assert.deepEqual((await fresh.service.image({ record: legacy, format })).bytes, result.bytes);
  }
  assert.equal(downloads, 3);
});

test("fifty concurrent requests for one card share a single render", async (t) => {
  captureMetrics(t);
  const memoryOnly = countingRenderer();
  const service = new CardImageService({
    memoryCacheBytes: 1024 * 1024,
    persistence: null,
    render: memoryOnly.render,
  });
  const images = await Promise.all(
    Array.from({ length: 50 }, () => service.image({ format: "share", record: RECORD })),
  );
  assert.equal(memoryOnly.calls.length, 1);
  assert.equal(new Set(images.map((image) => image.bytes.toString())).size, 1);
  assert.equal(images[0]?.contentType, "image/png");
  assert.equal(images[0]?.width, 1200);
  assert.equal(images[0]?.height, 675);
  assert.equal((await service.image({ format: "share", record: RECORD })).source, "memory");
  assert.equal(service.storeKind, "memory");

  const persisting = countingRenderer();
  const { catalog, service: persisted, store } = persistedService(persisting.render);
  const results = await Promise.all(
    Array.from({ length: 50 }, () => persisted.image({ format: "card", record: RECORD })),
  );
  assert.equal(persisting.calls.length, 1);
  assert.equal(catalog.finds, 1);
  assert.equal(store.writes, 1);
  assert.equal(catalog.records, 1);
  assert.equal(catalog.rows.size, 1);
  assert.deepEqual(new Set(results.map((image) => image.source)), new Set(["render"]));
});

test("instances racing on a cold key render at most once each and keep one catalog row", async (t) => {
  captureMetrics(t);
  const persistence = { catalog: new FakeCatalog(), store: new FakeStore() };
  const first = countingRenderer();
  const second = countingRenderer();
  const one = persistedService(first.render, persistence).service;
  const two = persistedService(second.render, persistence).service;
  const images = await Promise.all(Array.from({ length: 40 }, (_, index) =>
    (index % 2 === 0 ? one : two).image({ format: "share", record: RECORD })));
  assert.ok(first.calls.length <= 1 && second.calls.length <= 1);
  assert.equal(persistence.catalog.rows.size, 1);
  assert.equal(persistence.store.objects.size, 1);
  assert.equal(new Set(images.map((image) => image.bytes.toString())).size, 1);
});

test("a fresh instance serves persisted bytes from the store without rendering", async (t) => {
  captureMetrics(t);
  const first = countingRenderer();
  const { catalog, service, store } = persistedService(first.render);
  const rendered = await service.image({ format: "share", record: RECORD });
  assert.equal(rendered.source, "render");

  const second = countingRenderer();
  const { service: fresh } = persistedService(second.render, { catalog, store });
  const stored = await fresh.image({ format: "share", record: structuredClone(RECORD) });
  assert.equal(stored.source, "store");
  assert.deepEqual(stored.bytes, rendered.bytes);
  assert.equal(second.calls.length, 0);
  assert.equal((await fresh.image({ format: "share", record: RECORD })).source, "memory");

  // Formats are separate renders.
  assert.equal((await fresh.image({ format: "card", record: RECORD })).source, "render");
  assert.equal(second.calls.length, 1);
  assert.equal(catalog.rows.size, 2);
});

test("the memory cache evicts least recently used entries by total bytes", () => {
  const cache = new ByteLruCache(10);
  cache.set("a", Buffer.alloc(4));
  cache.set("b", Buffer.alloc(4));
  assert.ok(cache.get("a"));
  cache.set("c", Buffer.alloc(4));
  assert.equal(cache.get("b"), undefined, "b was least recently used");
  assert.ok(cache.get("a"));
  assert.ok(cache.get("c"));
  assert.equal(cache.bytes, 8);

  cache.set("a", Buffer.alloc(6));
  assert.equal(cache.bytes, 10);
  assert.equal(cache.size, 2);
  cache.set("huge", Buffer.alloc(11));
  assert.equal(cache.get("huge"), undefined, "an entry larger than the cache is not kept");
  assert.equal(cache.bytes, 10);
  cache.set("d", Buffer.alloc(9));
  assert.deepEqual([cache.get("a"), cache.get("c")], [undefined, undefined]);
  assert.equal(cache.bytes, 9);

  const disabled = new ByteLruCache(0);
  disabled.set("a", Buffer.alloc(1));
  assert.equal(disabled.size, 0);
  assert.throws(() => new ByteLruCache(-1), RangeError);
});

test("oversized and empty replacements clear only their own cached image", () => {
  const cache = new ByteLruCache(8);
  cache.set("a", Buffer.alloc(4));
  cache.set("b", Buffer.alloc(4));
  cache.set("a", Buffer.alloc(9));
  assert.equal(cache.get("a"), undefined);
  assert.ok(cache.get("b"), "an oversized replacement does not evict other images");
  assert.deepEqual([cache.size, cache.bytes], [1, 4]);

  cache.set("b", Buffer.alloc(0));
  assert.equal(cache.get("b"), undefined, "an empty replacement cannot leave stale bytes");
  for (let index = 0; index < 1_000; index += 1) cache.set(String(index), Buffer.alloc(0));
  assert.deepEqual([cache.size, cache.bytes], [0, 0], "zero-byte values cannot accumulate keys");

  const disabled = new ByteLruCache(0);
  disabled.set("empty", Buffer.alloc(0));
  disabled.set("image", Buffer.alloc(1));
  assert.deepEqual([disabled.size, disabled.bytes, disabled.get("image")], [0, 0, undefined]);
});

test("a byte-bounded memory cache falls back to the store once an image is evicted", async (t) => {
  captureMetrics(t);
  const renderer = countingRenderer(0);
  const other = cardRecord("fixture-crew-other");
  // Room for either image, not both.
  const size = Buffer.from(`png:${other.cardId}:share`).byteLength;
  const { service } = persistedService(renderer.render, undefined, { memoryCacheBytes: size });
  assert.equal((await service.image({ format: "share", record: RECORD })).source, "render");
  assert.equal((await service.image({ format: "share", record: RECORD })).source, "memory");
  assert.equal((await service.image({ format: "share", record: other })).source, "render");
  assert.equal((await service.image({ format: "share", record: RECORD })).source, "store");
  assert.equal(renderer.calls.length, 2);
});

test("store and catalog failures degrade to serving a fresh render", async (t) => {
  const metrics = captureMetrics(t);
  const storeErrors = () => metrics()
    .filter((metric) => metric.metric === "card.image.store_error")
    .map((metric) => metric.operation);

  // The object store rejects writes: serve the render, persist nothing.
  const writeFails = persistedService(countingRenderer(0).render);
  writeFails.store.failWrite = Object.assign(new Error("blob down"), { name: "BlobServiceNotAvailable" });
  const unwritten = await writeFails.service.image({ format: "share", record: RECORD });
  assert.equal(unwritten.source, "render");
  assert.equal(unwritten.bytes.toString(), `png:${RECORD.cardId}:share`);
  assert.equal(writeFails.catalog.rows.size, 0);

  // The catalog cannot be read.
  const lookupFails = persistedService(countingRenderer(0).render);
  lookupFails.catalog.failFind = Object.assign(new Error("db down"), { code: "57P01" });
  assert.equal((await lookupFails.service.image({ format: "share", record: RECORD })).source, "render");
  assert.equal(lookupFails.store.writes, 0);

  // Recording the catalog row fails after the upload: the render is served, not repeated.
  const recordFails = countingRenderer(0);
  const recording = persistedService(recordFails.render);
  recording.catalog.failRecord = Object.assign(new Error("pool exhausted"), { code: "53300" });
  assert.equal((await recording.service.image({ format: "share", record: RECORD })).source, "render");
  assert.equal(recordFails.calls.length, 1);
  assert.equal(recording.catalog.rows.size, 0);

  // A catalogued object cannot be read: render, and leave the store alone.
  const readFails = countingRenderer(0);
  const reading = persistedService(readFails.render);
  await persistedService(countingRenderer(0).render, reading).service.image({ format: "share", record: RECORD });
  reading.store.failRead = new Error("blob read failed");
  assert.equal((await reading.service.image({ format: "share", record: RECORD })).source, "render");
  assert.equal(reading.store.writes, 1);

  assert.deepEqual(storeErrors(), ["write", "lookup", "record", "read"]);
  const renders = metrics().filter((metric) => metric.metric === "card.render");
  assert.ok(renders.every((metric) => metric.outcome === "ok" && typeof metric.durationMs === "number"));
  const served = metrics().filter((metric) => metric.metric === "card.image");
  assert.ok(served.every((metric) => metric.outcome === "ok" && metric.source === "render"));
});

test("a catalogued object that went missing is rendered and written again", async (t) => {
  captureMetrics(t);
  const renderer = countingRenderer(0);
  const { catalog, service, store } = persistedService(renderer.render, undefined, { memoryCacheBytes: 0 });
  await service.image({ format: "card", record: RECORD });
  store.objects.clear();
  const healed = await service.image({ format: "card", record: RECORD });
  assert.equal(healed.source, "render");
  assert.equal(store.writes, 2);
  assert.equal(store.objects.size, 1);
  assert.equal(catalog.rows.size, 1);
  assert.equal((await service.image({ format: "card", record: RECORD })).source, "store");
});

test("render failures are errors, and are retried rather than cached", async (t) => {
  const metrics = captureMetrics(t);
  let attempts = 0;
  const { service, store } = persistedService(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("rasterizer outage");
    return Buffer.from("png");
  });
  await assert.rejects(service.image({ format: "share", record: RECORD }), /rasterizer outage/);
  assert.equal(store.writes, 0);
  assert.equal((await service.image({ format: "share", record: RECORD })).source, "render");
  await assert.rejects(service.image({ format: "share", record: { ...RECORD, crew: 0 } }));
  assert.deepEqual(
    metrics().filter((metric) => metric.metric === "card.image").map((metric) => metric.outcome),
    ["error", "ok", "error"],
  );
});

test("persisted bytes are identical to a direct render in both formats", async (t) => {
  captureMetrics(t);
  const persistence = { catalog: new FakeCatalog(), store: new FakeStore() };
  const service = new CardImageService({
    memoryCacheBytes: 0,
    persistence,
    render: renderCardImageWithSharp,
  });
  for (const format of ["card", "share"] as const satisfies readonly CardImageFormat[]) {
    const direct = await renderSeasonZeroCardPng(RECORD, {}, format);
    const served = await service.image({ format, record: RECORD });
    assert.equal(served.source, "render");
    assert.deepEqual(served.bytes, direct.bytes);
    assert.deepEqual([served.width, served.height], [direct.width, direct.height]);
    const stored = persistence.store.objects.get(
      cardImagePathname({ cardId: RECORD.cardId, digest: served.digest, format }),
    );
    assert.deepEqual(stored, direct.bytes);
    const reread = await service.image({ format, record: RECORD });
    assert.equal(reread.source, "store");
    assert.deepEqual(reread.bytes, direct.bytes);
  }
});

test("the blob store writes private, unsuffixed, long-cached objects and reads them server-side", async () => {
  const puts: Array<{ body: Buffer; options: Parameters<BlobPut>[2]; pathname: string }> = [];
  const gets: Array<{ options: Parameters<BlobGet>[1]; pathname: string }> = [];
  const objects = new Map<string, Buffer>();
  let getStatus = 200;
  const store = new VercelBlobCardImageStore({
    access: "private",
    async get(pathname, options) {
      gets.push({ options, pathname });
      const bytes = objects.get(pathname);
      if (!bytes) return null;
      return getStatus === 200
        ? { statusCode: 200, stream: new Blob([new Uint8Array(bytes)]).stream() }
        : { statusCode: getStatus, stream: null };
    },
    async put(pathname, body, options) {
      puts.push({ body, options, pathname });
      objects.set(pathname, Buffer.from(body));
      return { url: `https://store.private.blob.vercel-storage.com/${pathname}` };
    },
    token: "vercel_blob_rw_fake_not_a_token",
  });

  const pathname = "mission-control/cards/card/share-abc.png";
  assert.equal(await store.read(pathname), null);
  const written = await store.write(pathname, Buffer.from("png-bytes"));
  assert.equal(written.url, `https://store.private.blob.vercel-storage.com/${pathname}`);
  assert.equal(puts.length, 1);
  const { abortSignal, ...putOptions } = puts[0]!.options;
  assert.ok(abortSignal instanceof AbortSignal);
  assert.deepEqual(putOptions, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31_536_000,
    contentType: "image/png",
    token: "vercel_blob_rw_fake_not_a_token",
  });
  assert.equal(puts[0]!.pathname, pathname);
  assert.deepEqual(await store.read(pathname), Buffer.from("png-bytes"));
  assert.equal(gets.at(-1)?.options.access, "private");
  assert.equal(gets.at(-1)?.options.token, "vercel_blob_rw_fake_not_a_token");
  getStatus = 304;
  await assert.rejects(store.read(pathname), /304/);
});

test("blob SDK failures log a safe code instead of the bare class name", () => {
  const codeOf = (message: string) => (classifyBlobError(new Error(message)) as { code: string }).code;
  // The exact texts of @vercel/blob 2.8.1.
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["Vercel Blob: Failed to fetch blob: 403 Forbidden", "blob_http_403"],
    ["Vercel Blob: Failed to fetch blob: 503 Service Unavailable", "blob_http_503"],
    ["Vercel Blob: Access denied, please provide a valid token for this resource.", "blob_access_denied"],
    ["Vercel Blob: Cannot use private access on a public store. The store must be configured with private access.", "blob_access_mismatch"],
    ["Vercel Blob: No read-write token found. Either configure the `BLOB_READ_WRITE_TOKEN` environment variable, or pass a `token` option to your calls.", "blob_token_invalid"],
    ["Vercel Blob: Invalid token: unable to extract store ID", "blob_token_invalid"],
    ["Vercel Blob: This store does not exist.", "blob_store_not_found"],
    ["Vercel Blob: This store has been suspended.", "blob_store_suspended"],
    ["Vercel Blob: The blob service is currently not available. Please try again.", "blob_service_unavailable"],
    ["Vercel Blob: Too many requests please try again in 5 seconds.", "blob_rate_limited"],
    ["Vercel Blob: The request was aborted.", "blob_aborted"],
    ["Vercel Blob: File is too large, limit exceeded.", "blob_file_too_large"],
    ["Vercel Blob: Content type mismatch, nope.", "blob_content_type"],
    ["Vercel Blob: Unknown error, please visit https://vercel.com/help.", "blob_unknown"],
    ["Vercel Blob: Could not generate a separate store", "blob_error"],
  ];
  for (const [message, code] of cases) assert.equal(codeOf(message), code, message);
  const unknown = classifyBlobError(new Error("Vercel Blob: https://example.test/private?token=secret123 eyJhbGciOiJIUzI1NiJ9.payload.signature baresecret"));
  assert.equal(unknown.code, "blob_error");
  assert.equal(unknown.message, "Card image store failed: blob_error.");
  assert.equal(unknown.cause, undefined);
  assert.deepEqual(Object.keys(unknown), ["code"]);
  const nonError = classifyBlobError({ code: "baresecret", name: "baresecret", detail: "https://example.test/private?token=secret123" });
  assert.equal(nonError.code, "blob_error");
  assert.equal(nonError.message, "Card image store failed: blob_error.");
  assert.equal(nonError.cause, undefined);
  assert.deepEqual(Object.keys(nonError), ["code"]);
});

test("the blob store logs the classified code for failed reads and writes", async () => {
  const store = new VercelBlobCardImageStore({
    access: "private",
    async get() { throw new Error("Vercel Blob: Failed to fetch blob: 401 Unauthorized"); },
    async put() { throw new Error("Vercel Blob: This store has been suspended."); },
    token: "vercel_blob_rw_fake_not_a_token",
  });
  await assert.rejects(store.read("a.png"), { code: "blob_http_401" });
  await assert.rejects(store.write("a.png", Buffer.from("x")), { code: "blob_store_suspended" });
});

test("a failed blob stream cannot expose provider error fields", async () => {
  const store = new VercelBlobCardImageStore({
    access: "private",
    async get() {
      return { statusCode: 200, stream: new ReadableStream({
        start(controller) { controller.error(Object.assign(new Error("opaque-secret"), { code: "opaque_secret", name: "opaque_secret" })); },
      }) };
    },
    async put() { throw new Error("unexpected write"); },
    token: "fake-token",
  });
  await assert.rejects(store.read("a.png"), (error: Error & { code?: string }) => {
    assert.equal(error.code, "blob_error");
    assert.equal(error.name, "Error");
    assert.equal(error.message, "Card image store failed: blob_error.");
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("the filesystem store writes atomically and stays inside its directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "card-images-unit-"));
  try {
    const store = new FilesystemCardImageStore(directory);
    const pathname = "mission-control/cards/card-1/card-digest.png";
    assert.equal(await store.read(pathname), null);
    const { url } = await store.write(pathname, Buffer.from("first"));
    assert.equal(url, `file://${join(directory, pathname)}`);
    await store.write(pathname, Buffer.from("second"));
    assert.deepEqual(await store.read(pathname), Buffer.from("second"));
    assert.deepEqual(await readdir(join(directory, "mission-control/cards/card-1")), ["card-digest.png"]);
    await assert.rejects(store.write("../escape.png", Buffer.from("x")), /escapes/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("storage and cache settings come from the environment", () => {
  const store = (environment: Record<string, string>) =>
    cardImageStore(cardImageSettingsFromEnvironment(environment).store);
  assert.equal(store({}), null);
  assert.equal(store({ CARD_IMAGE_DIRECTORY: "/tmp/cards" })?.kind, "filesystem");
  assert.equal(
    store({
      BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_fake_not_a_token",
      CARD_IMAGE_DIRECTORY: "/tmp/cards",
    })?.kind,
    "vercel-blob",
  );
  // An invalid access setting fails even without a blob token: it is parsed once at boot.
  assert.throws(
    () => cardImageSettingsFromEnvironment({ CARD_IMAGE_BLOB_ACCESS: "world-readable" }),
    /^Error: CARD_IMAGE_BLOB_ACCESS must be private or public\.$/,
  );
  assert.deepEqual(cardImageSettingsFromEnvironment({}), {
    memoryCacheBytes: 64 * 1024 * 1024,
    renderConcurrency: 2,
    renderQueue: 16,
    store: { blobToken: null, access: "private", directory: null },
  });
  assert.deepEqual(
    cardImageSettingsFromEnvironment({
      CARD_IMAGE_MEMORY_CACHE_BYTES: "0",
      CARD_RENDER_CONCURRENCY: " 8 ",
      CARD_RENDER_QUEUE: "0",
    }),
    {
      memoryCacheBytes: 0,
      renderConcurrency: 8,
      renderQueue: 0,
      store: { blobToken: null, access: "private", directory: null },
    },
  );
  assert.throws(() => cardImageSettingsFromEnvironment({ CARD_IMAGE_MEMORY_CACHE_BYTES: "lots" }));
  assert.throws(() => cardImageSettingsFromEnvironment({ CARD_IMAGE_MEMORY_CACHE_BYTES: "-1" }));
  for (const value of ["0", "9", "1.5", "two"]) {
    assert.throws(
      () => cardImageSettingsFromEnvironment({ CARD_RENDER_CONCURRENCY: value }),
      /CARD_RENDER_CONCURRENCY must be an integer from 1 to 8/,
    );
  }
  for (const value of ["-1", "65"]) {
    assert.throws(
      () => cardImageSettingsFromEnvironment({ CARD_RENDER_QUEUE: value }),
      /CARD_RENDER_QUEUE must be an integer from 0 to 64/,
    );
  }
});

test("the public image route hides unpublished cards and lets the CDN keep published ones", async (t) => {
  captureMetrics(t);
  const renderer = countingRenderer(0);
  const { service } = persistedService(renderer.render);
  const published = new Map([[RECORD.cardId, publishedSnapshot(RECORD)]]);
  const dependencies = {
    images: service,
    published: new LRUCache<string, string>({ max: 10 }),
    publishedCard: async (cardId: string) => published.get(cardId) ?? null,
  };

  const missing = await publicCardImageResponse("unpublished", dependencies);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal(missing.headers.get("retry-after"), null);
  assert.equal(renderer.calls.length, 0);

  const response = await publicCardImageResponse(RECORD.cardId, dependencies, "share", 0);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(response.headers.get("cache-control"), PUBLIC_CARD_IMAGE_CACHE_CONTROL);
  assert.equal(PUBLIC_CARD_IMAGE_CACHE_CONTROL, "public, max-age=86400, s-maxage=31536000, immutable");
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.toString(), `png:${RECORD.cardId}:share`);
  assert.equal(response.headers.get("content-length"), String(body.byteLength));

  const stale = await publicCardImageResponse(RECORD.cardId, dependencies, "share", 1);
  assert.equal(stale.status, 307);
  assert.equal(stale.headers.get("cache-control"), "no-store");
  assert.equal(stale.headers.get("location"), publicCardImagePath(RECORD.cardId, "share", 0));

  const fullCard = await publicCardImageResponse(RECORD.cardId, dependencies, "card");
  assert.equal(fullCard.status, 200);
  assert.equal(
    Buffer.from(await fullCard.arrayBuffer()).toString(),
    `png:${RECORD.cardId}:card`,
  );

  const failing = await publicCardImageResponse(RECORD.cardId, {
    ...dependencies,
    published: new LRUCache<string, string>({ max: 10 }),
    images: { cached: () => null, image: async () => { throw new Error("render failed"); } },
  }, "share", 0);
  assert.equal(failing.status, 503);
  assert.equal(failing.headers.get("cache-control"), "no-store");
  assert.equal(failing.headers.get("retry-after"), "5");
  const lookupFails = await publicCardImageResponse(RECORD.cardId, {
    ...dependencies,
    published: new LRUCache<string, string>({ max: 10 }),
    publishedCard: async () => { throw new Error("db down"); },
  });
  assert.equal(lookupFails.status, 503);
  assert.equal(lookupFails.headers.get("cache-control"), "no-store");
  assert.equal(lookupFails.headers.get("retry-after"), "5");
});

/** Renders that wait at a gate until the test opens it, tracking how many run at once. */
function gatedRenderer() {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const render: CardImageRenderer = async (record, format) => {
    calls.push(`${record.cardId}/${format}`);
    active += 1;
    peak = Math.max(peak, active);
    try {
      await gate;
      return Buffer.from(`png:${record.cardId}:${format}`);
    } finally {
      active -= 1;
    }
  };
  return { calls, open, peak: () => peak, render };
}

/** Lets every pending continuation (catalog lookups, slot grants) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("render slots bound concurrent renders and shed cold keys once the wait queue is full", async (t) => {
  const metrics = captureMetrics(t);
  const renderer = gatedRenderer();
  const service = new CardImageService({
    memoryCacheBytes: 1024 * 1024,
    persistence: { catalog: new FakeCatalog(), store: new FakeStore() },
    render: renderer.render,
    renderConcurrency: 2,
    renderQueue: 3,
  });

  const requests = Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    service.image({ format: "share", record: cardRecord(`fixture-crew-cold-${index}`) })));
  await settle();
  assert.equal(renderer.calls.length, 2, "two render, three wait, five are shed");
  renderer.open();
  const results = await requests;

  const served = results.filter((result) => result.status === "fulfilled");
  const shed = results.filter((result) => result.status === "rejected");
  assert.equal(served.length, 5);
  assert.equal(shed.length, 5);
  for (const result of shed) {
    assert.ok(result.reason instanceof CardImageBusyError);
    assert.equal(result.reason.reason, "queue_full");
  }
  assert.equal(renderer.peak(), 2);
  assert.equal(renderer.calls.length, 5);
  assert.deepEqual(
    results.map((result) => result.status),
    [...Array(5).fill("fulfilled"), ...Array(5).fill("rejected")],
    "slots and queue places go in arrival order",
  );
  const sheds = metrics().filter((metric) => metric.metric === "card.render.shed");
  assert.equal(sheds.length, 5);
  assert.deepEqual(
    { active: sheds[0]?.active, reason: sheds[0]?.reason, waiting: sheds[0]?.waiting },
    { active: 2, reason: "queue_full", waiting: 3 },
  );
  assert.ok(metrics()
    .filter((metric) => metric.metric === "card.render")
    .every((metric) => typeof metric.waitMs === "number"));

  // A shed key is not remembered as failed: it renders on the next request.
  const retried = await service.image({ format: "share", record: cardRecord("fixture-crew-cold-9") });
  assert.equal(retried.source, "render");
});

test("memory and store hits are served while every render slot and queue place is taken", async (t) => {
  captureMetrics(t);
  const persistence = { catalog: new FakeCatalog(), store: new FakeStore() };
  // Another instance already persisted this card.
  const storedRecord = cardRecord("fixture-crew-stored");
  await persistedService(countingRenderer(0).render, persistence).service
    .image({ format: "share", record: storedRecord });

  const renderer = gatedRenderer();
  let warmed = false;
  const service = new CardImageService({
    memoryCacheBytes: 1024 * 1024,
    persistence,
    render: async (record, format) => {
      if (!warmed) return Buffer.from(`png:${record.cardId}:${format}`);
      return renderer.render(record, format);
    },
    renderConcurrency: 1,
    renderQueue: 1,
  });
  assert.equal((await service.image({ format: "share", record: RECORD })).source, "render");
  warmed = true;

  const saturating = [
    service.image({ format: "share", record: cardRecord("fixture-crew-slow-1") }),
    service.image({ format: "share", record: cardRecord("fixture-crew-slow-2") }),
  ];
  const overflow = service.image({ format: "share", record: cardRecord("fixture-crew-slow-3") })
    .then(() => null, (error: unknown) => error);
  await settle();
  assert.equal(renderer.calls.length, 1, "one render holds the only slot, one waits");
  assert.ok((await overflow) instanceof CardImageBusyError);

  const hits = await Promise.all(Array.from({ length: 20 }, () =>
    service.image({ format: "share", record: RECORD })));
  assert.deepEqual(sourcesOf(hits), ["memory"]);
  const key = { cardId: RECORD.cardId, digest: hits[0]!.digest, format: "share" as const };
  assert.equal(service.cached(key)?.source, "memory");
  assert.equal((await service.image({ format: "share", record: storedRecord })).source, "store");
  assert.equal(renderer.calls.length, 1, "only the first slow render has a slot");

  renderer.open();
  assert.deepEqual(
    (await Promise.all(saturating)).map((image) => image.source),
    ["render", "render"],
  );
});

test("a render that waits too long for a slot is shed", async (t) => {
  const metrics = captureMetrics(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const renderer = gatedRenderer();
  const service = new CardImageService({
    memoryCacheBytes: 1024 * 1024,
    persistence: null,
    render: renderer.render,
    renderConcurrency: 1,
    renderQueue: 4,
  });
  const running = service.image({ format: "share", record: cardRecord("fixture-crew-running") });
  const waiting = service.image({ format: "share", record: cardRecord("fixture-crew-waiting") });
  await settle();
  t.mock.timers.tick(10_000);
  // Opened first so a regression fails instead of waiting at the gate forever.
  renderer.open();
  await assert.rejects(waiting, (error: unknown) =>
    error instanceof CardImageBusyError && error.reason === "wait_timeout");
  assert.equal((await running).source, "render");
  assert.deepEqual(
    metrics().filter((metric) => metric.metric === "card.render.shed").map((metric) => metric.reason),
    ["wait_timeout"],
  );
  assert.throws(
    () => new CardImageService({ memoryCacheBytes: 0, persistence: null, render: renderer.render, renderQueue: -1 }),
    RangeError,
  );
  assert.throws(
    () => new CardImageService({ memoryCacheBytes: 0, persistence: null, render: renderer.render, renderConcurrency: 0 }),
    TypeError,
  );
});

function sourcesOf(images: readonly { source: string }[]): string[] {
  return [...new Set(images.map((image) => image.source))].sort();
}

test("the public route serves a remembered full card from memory without the database", async (t) => {
  captureMetrics(t);
  const renderer = countingRenderer(0);
  const { catalog, service } = persistedService(renderer.render);
  const publishedCards = new Map([[RECORD.cardId, publishedSnapshot(RECORD)]]);
  const lookups: string[] = [];
  const dependencies = {
    images: service,
    published: new LRUCache<string, string>({ max: 10 }),
    publishedCard: async (cardId: string) => {
      lookups.push(cardId);
      return publishedCards.get(cardId) ?? null;
    },
  };

  const first = await publicCardImageResponse(RECORD.cardId, dependencies, "card");
  assert.equal(first.status, 200);
  assert.deepEqual([lookups.length, catalog.finds], [1, 1]);
  assert.equal(dependencies.published.get(RECORD.cardId), cardImageIdentity(RECORD).digest);

  for (const id of [RECORD.cardId, RECORD.cardId.toUpperCase()]) {
    const again = await publicCardImageResponse(id, dependencies, "card");
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("cache-control"), PUBLIC_CARD_IMAGE_CACHE_CONTROL);
    assert.equal(Buffer.from(await again.arrayBuffer()).toString(), `png:${RECORD.cardId}:card`);
  }
  assert.deepEqual([lookups.length, catalog.finds, renderer.calls.length], [1, 1, 1], "no database, store or render");

  // Unpublished (or unknown) cards are looked up on every request, never remembered.
  const later = cardRecord("fixture-crew-later");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await publicCardImageResponse(later.cardId, dependencies, "card")).status, 404);
  }
  assert.equal(lookups.filter((id) => id === later.cardId).length, 3);
  assert.equal(dependencies.published.get(later.cardId), undefined);
  publishedCards.set(later.cardId, publishedSnapshot(later));
  assert.equal((await publicCardImageResponse(later.cardId, dependencies, "card")).status, 200);
  assert.equal(lookups.filter((id) => id === later.cardId).length, 4);

  // A remembered card whose image left memory takes the full path again.
  const forgetful = persistedService(countingRenderer(0).render, undefined, { memoryCacheBytes: 0 });
  const evicting = { ...dependencies, images: forgetful.service };
  const before = lookups.length;
  assert.equal((await publicCardImageResponse(RECORD.cardId, evicting, "card")).status, 200);
  assert.equal(lookups.length, before + 1);

  // The remembered-id cache is bounded by entry count.
  const ids = new LRUCache<string, string>({ max: 2 });
  ids.set("a", "1");
  ids.set("b", "2");
  assert.equal(ids.get("a"), "1");
  ids.set("c", "3");
  assert.deepEqual([ids.get("a"), ids.get("b"), ids.get("c"), ids.size], ["1", undefined, "3", 2]);
});

test("a shed or misconfigured render answers 503 that no cache keeps", async () => {
  const published = new LRUCache<string, string>({ max: 10 });
  const busy = await publicCardImageResponse(RECORD.cardId, {
    images: { cached: () => null, image: async () => { throw new CardImageBusyError("queue_full"); } },
    published,
    publishedCard: async () => publishedSnapshot(RECORD),
  }, "share", 0);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "5");
  assert.equal(busy.headers.get("cache-control"), "no-store");
  assert.equal(published.size, 0);

  // Dependencies resolve lazily, so a bad setting throws inside the handler.
  published.set(RECORD.cardId, cardImageIdentity(RECORD).digest);
  const misconfigured = await publicCardImageResponse(RECORD.cardId, {
    images: {
      cached: () => { throw new Error("CARD_RENDER_QUEUE must be an integer from 0 to 64."); },
      image: async () => { throw new Error("unreachable"); },
    },
    published,
    publishedCard: async () => publishedSnapshot(RECORD),
  }, "card");
  assert.equal(misconfigured.status, 503);
  assert.equal(misconfigured.headers.get("cache-control"), "no-store");
  assert.equal(misconfigured.headers.get("retry-after"), "5");
});

test("warming a published card stores its share image and waits out busy renders", async (t) => {
  captureMetrics(t);
  const renderer = countingRenderer(0);
  const { service } = persistedService(renderer.render);
  const records = new Map([[RECORD.cardId, publishedSnapshot(RECORD)]]);
  const slept: number[] = [];
  let clock = 0;
  const base = {
    now: () => clock,
    published: new LRUCache<string, string>({ max: 10 }),
    publishedCard: async (cardId: string) => records.get(cardId) ?? null,
    sleep: async (delayMs: number) => { slept.push(delayMs); clock += delayMs; },
  };

  assert.equal(await warmPublicCardImage("unpublished", { ...base, images: service }), "unpublished");
  assert.equal(await warmPublicCardImage(RECORD.cardId.toUpperCase(), { ...base, images: service }), "stored");
  assert.deepEqual(renderer.calls, [`${RECORD.cardId}/share`]);
  const served = await publicCardImageResponse(RECORD.cardId, { ...base, images: service }, "share", 0);
  assert.equal(served.status, 200);
  assert.equal(renderer.calls.length, 1, "the image route serves the warmed image without rendering");

  let lookups = 0;
  const counted = { ...base, publishedCard: async (cardId: string) => { lookups += 1; return base.publishedCard(cardId); } };
  let busyLeft = 5;
  const busyThenFree = {
    cached: () => null,
    image: async (input: Readonly<{ format: CardImageFormat; record: unknown }>) => {
      if (busyLeft-- > 0) throw new CardImageBusyError("queue_full");
      return service.image(input);
    },
  };
  assert.equal(await warmPublicCardImage(RECORD.cardId, { ...counted, images: busyThenFree }), "stored");
  assert.deepEqual(slept, Array(5).fill(5_000));
  assert.equal(lookups, 1, "the card is looked up once, whatever the retries");

  slept.length = 0;
  const alwaysBusy = { cached: () => null, image: async () => { throw new CardImageBusyError("wait_timeout"); } };
  assert.equal(await warmPublicCardImage(RECORD.cardId, { ...base, images: alwaysBusy }), "busy");
  assert.equal(slept.length, WARM_PUBLIC_CARD_IMAGE_BUDGET_MS / 5_000, "busy renders are waited out for the whole budget");

  slept.length = 0;
  const broken = { cached: () => null, image: async () => { throw new Error("render failed"); } };
  assert.equal(await warmPublicCardImage(RECORD.cardId, { ...base, images: broken }), "failed");
  assert.equal(await warmPublicCardImage(RECORD.cardId, {
    ...base, images: service, publishedCard: async () => { throw new Error("db down"); },
  }), "failed");
  assert.deepEqual(slept, [], "only busy renders are waited out");
});

test("the public image URL carries the renderer version and still passes the route policy", () => {
  const path = publicCardImagePath(RECORD.cardId);
  assert.equal(
    path,
    `/card/${RECORD.cardId}/image?v=${encodeURIComponent(CARD_RENDERER_VERSION)}`,
  );
  const url = new URL(path, "https://www.blast.fun");
  assert.equal(url.searchParams.get("v"), CARD_RENDERER_VERSION);
  assert.equal(url.searchParams.get("format"), null);
  const counted = new URL(publicCardImagePath(RECORD.cardId, "share", 5), url);
  assert.equal(counted.searchParams.get("recruits"), "5");
  const fullCard = new URL(publicCardImagePath(RECORD.cardId, "card"), url);
  assert.equal(fullCard.searchParams.get("format"), "card");
  assert.equal(fullCard.searchParams.get("v"), CARD_RENDERER_VERSION);
  const uuid = "4cd44a35-f169-4a44-8ed7-255de22102bb";
  const imagePath = new URL(publicCardImagePath(uuid), url).pathname;
  assert.equal(decideMissionControlRoute(imagePath, true), "allow");
  assert.equal(decideMissionControlRoute(imagePath, false), "allow");
  const sharePage = new URL(publicCardSharePath(RECORD.cardId), url);
  assert.equal(sharePage.pathname, `/card/${RECORD.cardId}`);
  assert.equal(sharePage.searchParams.get("v"), CARD_RENDERER_VERSION);
  assert.equal(sharePage.searchParams.get("social"), "2");
  assert.equal(new URL(publicCardSharePath(RECORD.cardId, 5), url).searchParams.get("recruits"), "5");
});

test("response bodies are views over the PNG buffer, not copies", () => {
  const slab = Buffer.alloc(64, 7);
  const bytes = slab.subarray(8, 24);
  const body = cardImageBody(bytes);
  assert.equal(body.buffer, slab.buffer);
  assert.deepEqual([body.byteOffset, body.byteLength], [bytes.byteOffset, 16]);
  bytes[0] = 9;
  assert.equal(body[0], 9);
});

test("review M3: only the canonical image URL is served; any other query or an uppercase id is redirected to it", () => {
  const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const origin = "https://www.blast.fun";
  const at = (path: string) => new Request(`${origin}${path}`);
  // What the app emits (the card page's <img>, the share metadata's og:image) is canonical.
  for (const path of [publicCardImagePath(id, "card"), publicCardImagePath(id, "share", 3), publicCardImagePath(id, "share")]) {
    assert.equal(canonicalCardImageRedirect(at(path), id), null, path);
  }
  const share = publicCardImagePath(id, "share", 3);
  const v = new URLSearchParams({ v: CARD_RENDERER_VERSION }).toString();
  for (const [path, location] of [
    [`${share}&z=123`, share],
    [`/card/${id}/image?z=1&recruits=3&${v}`, share],
    [`/card/${id}/image?recruits=3&v=old`, share],
    [`/card/${id}/image?recruits=3&${v}&${v}`, share],
    [`/card/${id}/image?recruits=003&${v}`, share],
    [`/card/${id}/image?format=share&recruits=3&${v}`, share],
    [`/card/${id}/image?format=card&recruits=3&${v}`, publicCardImagePath(id, "card")],
    [`/card/${id}/image`, publicCardImagePath(id, "share")],
    [`/card/${id.toUpperCase()}/image?recruits=3&${v}`, share],
  ] as const) {
    const answer = canonicalCardImageRedirect(at(path), path.split("/")[2]!);
    assert.equal(answer?.status, 307, path);
    assert.equal(answer?.headers.get("location"), location, path);
    assert.equal(answer?.headers.get("cache-control"), "no-store", path);
    // The canonical URL answers itself: no redirect loop.
    assert.equal(canonicalCardImageRedirect(at(location), id), null, `${path} -> ${location}`);
  }
  assert.deepEqual(cardImageQuery(new URLSearchParams("format=card&recruits=4")), { format: "card", recruitTotal: undefined });
  assert.deepEqual(cardImageQuery(new URLSearchParams("recruits=4")), { format: "share", recruitTotal: 4 });
  assert.deepEqual(cardImageQuery(new URLSearchParams("recruits=x")), { format: "share", recruitTotal: undefined });
  const route = readFileSync(new URL("../../../../../../packages/server/src/modules/mission-control/card-images/public-runtime.ts", import.meta.url), "utf8");
  assert.match(route, /canonicalCardImageRedirect\(request, id\);\n    if \(redirect\) return redirect;/, "redirects before counting or reading");
  assert.match(route, /dependencies.limit\(client, \["mission_control_card_image"\]/, "counts per client address before the card is read");
});

test("environment mock origins cannot relax the production X avatar allowlist", async () => {
  const original = process.env.X_AVATAR_ORIGIN;
  process.env.X_AVATAR_ORIGIN = "http://127.0.0.1:9999";
  try {
    await assert.rejects(snapshotApprovedXAvatar("http://127.0.0.1:9999/avatar.png", async () => {throw new Error("Must not fetch");}), (error: Error & {code?: string}) => error.code === "AVATAR_HOST_NOT_APPROVED");
  } finally {
    if (original === undefined) delete process.env.X_AVATAR_ORIGIN;
    else process.env.X_AVATAR_ORIGIN = original;
  }
});
