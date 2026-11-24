import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import sharp from "sharp";

import { createPresaleReceiptLogo, createPresaleReceiptRecord, type PresaleReceiptRecord } from "@blast/server/modules/mission-control/card-renderer/index.ts";
import { makeSeasonZeroCardFixtures } from "../../../../test/fixtures/modules/mission-control/card-renderer/fixtures.ts";
import {
  CardImageBusyError,
  CardImageService,
  cardImagePathname,
  presaleReceiptImageIdentity,
  presaleReceiptImagePathname,
  type CardImageCatalog,
  type CardImageKey,
  type CardImageLocation,
  type CardImageRenderer,
  type CardImageStore,
  type PresaleReceiptImageCatalog,
  type PresaleReceiptImageKey,
  type PresaleReceiptRenderer,
} from "@blast/server/modules/mission-control/card-images/index.ts";

/**
 * T-012 (AC-101): the card image service renders a second record kind, the
 * presale receipt, through the same memory cache, single flight, render
 * slots, object store and (its own) catalog, without changing season-zero
 * cards: their keys, paths, catalog and renderer are untouched.
 */

const [fixture] = await makeSeasonZeroCardFixtures();
const PRESALE = `0x${"a1".repeat(32)}`;
const WALLET = `0x${"7d".repeat(32)}`;

function receipt(overrides: Partial<PresaleReceiptRecord> = {}): PresaleReceiptRecord {
  return createPresaleReceiptRecord({
    schema: "blast.presale-receipt",
    version: 1,
    presaleId: PRESALE,
    wallet: WALLET,
    saleToken: `0x${"3f".repeat(32)}::froggy::FROGGY`,
    quote: `0x${"db".repeat(32)}::usdc::USDC`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SeasonCatalog implements CardImageCatalog {
  readonly keys: CardImageKey[] = [];
  async find(key: CardImageKey): Promise<CardImageLocation | null> {
    this.keys.push(key);
    return null;
  }
  async record(): Promise<void> {}
}

class ReceiptCatalog implements PresaleReceiptImageCatalog {
  readonly rows = new Map<string, CardImageLocation>();
  finds = 0;
  failFind: unknown = null;
  #id(key: PresaleReceiptImageKey) {
    return `${key.presaleId}/${key.wallet}/${key.format}/${key.digest}`;
  }
  async find(key: PresaleReceiptImageKey): Promise<CardImageLocation | null> {
    this.finds += 1;
    if (this.failFind) throw this.failFind;
    return this.rows.get(this.#id(key)) ?? null;
  }
  async record(key: PresaleReceiptImageKey, location: CardImageLocation): Promise<void> {
    if (!this.rows.has(this.#id(key))) this.rows.set(this.#id(key), location);
  }
}

class MemoryStore implements CardImageStore {
  readonly kind = "filesystem" as const;
  readonly objects = new Map<string, Buffer>();
  async read(pathname: string): Promise<Buffer | null> {
    return this.objects.get(pathname) ?? null;
  }
  async write(pathname: string, bytes: Buffer): Promise<{ url: string }> {
    this.objects.set(pathname, Buffer.from(bytes));
    return { url: `memory://${pathname}` };
  }
}

function receiptRenderer(delayMs = 20) {
  const calls: string[] = [];
  const render: PresaleReceiptRenderer = async (record, format) => {
    calls.push(`${record.wallet}/${format}/${record.amountCommitted}`);
    await sleep(delayMs);
    return Buffer.from(`receipt:${record.amountCommitted}:${format}`);
  };
  return { calls, render };
}

const seasonRender: CardImageRenderer = async (record, format) => Buffer.from(`card:${record.cardId}:${format}`);

function quiet(t: TestContext) {
  return t.mock.method(console, "info", () => {});
}

test("the receipt digest covers the canonical record and the receipt renderer version", () => {
  const record = receipt();
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  const { digest } = presaleReceiptImageIdentity(record);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(presaleReceiptImageIdentity(reordered).digest, digest, "key order never changes the digest");
  assert.notEqual(presaleReceiptImageIdentity(receipt({ amountCommitted: "2500000001" })).digest, digest);
  assert.notEqual(presaleReceiptImageIdentity(receipt({ crew: null })).digest, digest);
  assert.notEqual(presaleReceiptImageIdentity(receipt({ coinSymbol: "FROG" })).digest, digest);
  assert.throws(() => presaleReceiptImageIdentity({ ...record, amountCommitted: "x" }));
  assert.equal(
    presaleReceiptImagePathname({ presaleId: PRESALE, wallet: WALLET, format: "share", digest }),
    `presale/receipts/${PRESALE}/${WALLET}/share-${digest}.png`,
  );
  // Season-zero paths are unchanged.
  assert.equal(
    cardImagePathname({ cardId: fixture.record.cardId, format: "card", digest }),
    `mission-control/cards/${fixture.record.cardId}/card-${digest}.png`,
  );
});

test("the logo's bytes are in the digest: adding, removing or changing a logo changes it", async () => {
  const square = async (background: string) => createPresaleReceiptLogo(
    await sharp({ create: { width: 512, height: 512, channels: 4, background } }).png().toBuffer(),
  );
  const green = await square("#00ff00");
  const blue = await square("#0000ff");
  const digests = [null, green, blue].map((logo) => presaleReceiptImageIdentity(receipt({ logo })).digest);
  assert.equal(new Set(digests).size, 3);
  assert.equal(presaleReceiptImageIdentity(receipt({ logo: await square("#00ff00") })).digest, digests[1], "the same bytes, the same digest");
});

test("identical receipt records return identical bytes and render once", async (t) => {
  quiet(t);
  const { calls, render } = receiptRenderer();
  const service = new CardImageService({ memoryCacheBytes: 1024 * 1024, persistence: null, render: seasonRender, renderReceipt: render });
  const [first, concurrent] = await Promise.all([
    service.receiptImage({ format: "card", record: receipt() }),
    service.receiptImage({ format: "card", record: structuredClone(receipt()) }),
  ]);
  const second = await service.receiptImage({ format: "card", record: receipt() });
  assert.deepEqual(calls, [`${WALLET}/card/2500000000`]);
  assert.ok(first.bytes.equals(concurrent.bytes) && first.bytes.equals(second.bytes));
  assert.equal(second.source, "memory");
  assert.deepEqual(
    [second.presaleId, second.wallet, second.format, second.digest, second.width, second.height, second.contentType],
    [PRESALE, WALLET, "card", presaleReceiptImageIdentity(receipt()).digest, 2100, 1500, "image/png"],
  );

  const post = await service.receiptImage({ format: "share", record: receipt() });
  assert.deepEqual([post.width, post.height], [1200, 675]);
  const changed = await service.receiptImage({ format: "card", record: receipt({ amountCommitted: "3000000000" }) });
  assert.notEqual(changed.digest, first.digest);
  assert.equal(calls.length, 3);
});

test("a persisted receipt is served from the store by a new instance without rendering", async (t) => {
  quiet(t);
  const store = new MemoryStore();
  const receipts = new ReceiptCatalog();
  const season = new SeasonCatalog();
  const first = receiptRenderer();
  const one = new CardImageService({
    memoryCacheBytes: 1024 * 1024,
    persistence: { catalog: season, store, receipts },
    render: seasonRender,
    renderReceipt: first.render,
  });
  const rendered = await one.receiptImage({ format: "card", record: receipt() });
  assert.equal(rendered.source, "render");
  const pathname = presaleReceiptImagePathname({ presaleId: PRESALE, wallet: WALLET, format: "card", digest: rendered.digest });
  assert.deepEqual([...store.objects.keys()], [pathname]);
  assert.equal(receipts.rows.size, 1);
  assert.deepEqual(season.keys, [], "receipts never touch the season-zero catalog");

  const second = receiptRenderer();
  const two = new CardImageService({
    memoryCacheBytes: 1024 * 1024,
    persistence: { catalog: season, store, receipts },
    render: seasonRender,
    renderReceipt: second.render,
  });
  const stored = await two.receiptImage({ format: "card", record: receipt() });
  assert.equal(stored.source, "store");
  assert.ok(stored.bytes.equals(rendered.bytes));
  assert.deepEqual(second.calls, []);
});

test("a catalog failure still serves a fresh receipt render", async (t) => {
  quiet(t);
  const receipts = new ReceiptCatalog();
  receipts.failFind = Object.assign(new Error("down"), { code: "57P01" });
  const { calls, render } = receiptRenderer(0);
  const service = new CardImageService({
    memoryCacheBytes: 0,
    persistence: { catalog: new SeasonCatalog(), store: new MemoryStore(), receipts },
    render: seasonRender,
    renderReceipt: render,
  });
  const image = await service.receiptImage({ format: "card", record: receipt() });
  assert.equal(image.source, "render");
  assert.equal(calls.length, 1);
});

test("receipts and season-zero cards share the instance's render slots and queue", async (t) => {
  quiet(t);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new CardImageService({
    memoryCacheBytes: 0,
    persistence: null,
    renderConcurrency: 1,
    renderQueue: 0,
    render: async (record, format) => {
      await gate;
      return Buffer.from(`card:${record.cardId}:${format}`);
    },
    renderReceipt: async () => Buffer.from("receipt"),
  });
  const card = service.image({ format: "card", record: fixture.record });
  await sleep(10);
  await assert.rejects(service.receiptImage({ format: "card", record: receipt() }), CardImageBusyError);
  release();
  assert.equal((await card).source, "render");
  assert.equal((await service.receiptImage({ format: "card", record: receipt() })).source, "render");
});

test("unknown formats and invalid records are refused before any render", async (t) => {
  quiet(t);
  const { calls, render } = receiptRenderer(0);
  const service = new CardImageService({ memoryCacheBytes: 1024, persistence: null, render: seasonRender, renderReceipt: render });
  await assert.rejects(service.receiptImage({ format: "post" as never, record: receipt() }), TypeError);
  await assert.rejects(service.receiptImage({ format: "card", record: { ...receipt(), wallet: "0x1" } }));
  assert.deepEqual(calls, []);
});

test("season-zero images keep their keys and renderer alongside receipts", async (t) => {
  quiet(t);
  const season = new SeasonCatalog();
  const { render } = receiptRenderer(0);
  const service = new CardImageService({
    memoryCacheBytes: 1024 * 1024,
    persistence: { catalog: season, store: new MemoryStore(), receipts: new ReceiptCatalog() },
    render: seasonRender,
    renderReceipt: render,
  });
  const card = await service.image({ format: "card", record: fixture.record });
  assert.equal(card.cardId, fixture.record.cardId);
  assert.equal(card.bytes.toString(), `card:${fixture.record.cardId}:card`);
  assert.deepEqual(season.keys.map((key) => Object.keys(key).sort()), [["cardId", "digest", "format"]]);
  assert.equal(service.cached({ cardId: card.cardId, digest: card.digest, format: "card" })?.source, "memory");
});
