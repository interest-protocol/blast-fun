import { z } from "zod";
import type { Pool } from "pg";

import {
  createSemaphore,
  SemaphoreTimeoutError,
  type Release,
  type Semaphore,
} from "@blast/server/lib/concurrency.ts";
import { errorLabel, recordMetric, timed } from "@blast/core/lib/metrics.ts";
import {
  createShareCardStats,
  type SeasonZeroCardRecord,
  type ShareCardStats,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import type { PresaleReceiptRecord } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import {
  CARD_PNG_HEIGHT,
  CARD_PNG_WIDTH,
  CARD_SHARE_HEIGHT,
  CARD_SHARE_WIDTH,
} from "@blast/server/modules/mission-control/card-renderer/svg.ts";
import { autocommitRead } from "@blast/core/modules/database/transaction.ts";
import { primaryPool } from "@blast/core/modules/database/pool.ts";
import { upgradeCardAvatar } from "@blast/server/modules/mission-control/card-images/avatar.ts";
import { SingleFlight } from "@blast/server/modules/mission-control/card-images/single-flight.ts";
import {
  CARD_IMAGE_FORMATS,
  CardImageBusyError,
  type CardImage,
  type CardImageFormat,
  type CardImageKey,
  type CardImageLocation,
  type CardImageSource,
  type PresaleReceiptImage,
  type PresaleReceiptImageKey,
} from "@blast/core/modules/mission-control/card-images/contracts.ts";
import {
  cardImageIdentity,
  cardImagePathname,
  presaleReceiptImageIdentity,
  presaleReceiptImagePathname,
} from "@blast/server/modules/mission-control/card-images/digest.ts";
import { ByteLruCache } from "@blast/server/modules/mission-control/card-images/memory-cache.ts";
import {
  PostgresCardImageCatalog,
  PostgresPresaleReceiptImageCatalog,
  type CardImageCatalog,
  type PresaleReceiptImageCatalog,
} from "@blast/server/modules/mission-control/card-images/repository.ts";
import {
  cardImageStore,
  type CardImageStore,
  type CardImageStoreKind,
} from "@blast/server/modules/mission-control/card-images/store.ts";
import {
  CARD_RENDER_CONCURRENCY_DEFAULT,
  CARD_RENDER_QUEUE_DEFAULT,
  type CardImageSettings,
} from "@blast/server/modules/mission-control/card-images/settings.ts";
import { runtimeConfig } from "@blast/server/config/runtime-config.ts";

export type CardImageRenderer = (
  record: SeasonZeroCardRecord,
  format: CardImageFormat,
  stats?: ShareCardStats,
) => Promise<Buffer>;

/** The production renderer; sharp loads only when a render is actually needed. */
export const renderCardImageWithSharp: CardImageRenderer = async (record, format, stats) => {
  const { renderSeasonZeroCardPng } = await import("@blast/server/modules/mission-control/card-renderer/render.ts");
  return (await renderSeasonZeroCardPng(record, {}, format, stats)).bytes;
};

/** Draws a presale receipt record in one format (T-012). */
export type PresaleReceiptRenderer = (
  record: PresaleReceiptRecord,
  format: CardImageFormat,
) => Promise<Buffer>;

/** The production receipt renderer; resvg loads only when a render is actually needed. */
export const renderPresaleReceiptWithResvg: PresaleReceiptRenderer = async (record, format) => {
  const { renderPresaleReceiptPng } = await import("@blast/server/modules/mission-control/card-renderer/presale-receipt-svg.ts");
  return (await renderPresaleReceiptPng(record, format)).bytes;
};

export interface CardImagePersistence {
  readonly catalog: CardImageCatalog;
  readonly store: CardImageStore;
  /** The receipt catalog; without it receipts are rendered but not persisted. */
  readonly receipts?: PresaleReceiptImageCatalog;
}

/** A queued render that has not started after this long is shed, not served late. */
const RENDER_WAIT_TIMEOUT_MS = 10_000;

export interface CardImageServiceOptions {
  /** Upper bound on the PNG bytes this instance keeps in memory; 0 disables it. */
  readonly memoryCacheBytes: number;
  /** Null keeps renders in this instance's memory only. */
  readonly persistence: CardImagePersistence | null;
  readonly render: CardImageRenderer;
  /** Draws presale receipts (default: the resvg receipt renderer). */
  readonly renderReceipt?: PresaleReceiptRenderer;
  /** Renders this instance runs at once (default 2). */
  readonly renderConcurrency?: number;
  /** Renders that may wait for a slot (default 16); one more is shed with CardImageBusyError. */
  readonly renderQueue?: number;
}

type CardImageStoreOperation = "lookup" | "read" | "record" | "write";

interface Loaded {
  readonly bytes: Buffer;
  readonly source: CardImageSource;
}

/**
 * One image to serve, whatever its record kind: where it lives in memory and
 * in the store, its catalog row, and how to draw it.
 */
interface ImageJob {
  readonly format: CardImageFormat;
  /** Metric fields that name a non-season-zero kind; empty for season-zero cards. */
  readonly labels: Readonly<{ kind?: "presale-receipt" }>;
  readonly memoryKey: string;
  readonly pathname: string;
  /** Null: rendered without persisting. */
  readonly catalog: Readonly<{
    find(): Promise<CardImageLocation | null>;
    record(location: CardImageLocation): Promise<void>;
  }> | null;
  draw(): Promise<Buffer>;
}

const RECEIPT_LABELS = Object.freeze({ kind: "presale-receipt" as const });
const NO_LABELS = Object.freeze({});

type Stored =
  | Readonly<{ state: "found"; bytes: Buffer }>
  | Readonly<{ state: "failed" | "missing" }>;

function dimensions(format: CardImageFormat): Readonly<{ height: number; width: number }> {
  return format === "share"
    ? { height: CARD_SHARE_HEIGHT, width: CARD_SHARE_WIDTH }
    : { height: CARD_PNG_HEIGHT, width: CARD_PNG_WIDTH };
}

function memoryKeyOf(key: CardImageKey): string {
  return `${key.cardId}/${key.format}/${key.digest}`;
}

function receiptMemoryKey(key: PresaleReceiptImageKey): string {
  return `presale-receipt/${key.presaleId}/${key.wallet}/${key.format}/${key.digest}`;
}

/**
 * Serves each image of a record kind (a season-zero card by card, format and
 * record digest; a presale receipt by sale, wallet, format and digest) from memory, then object storage,
 * and otherwise renders it once per instance: concurrent requests on an
 * instance share one load. Instances do not coordinate, so a cold key renders
 * at most once per instance; the write is idempotent (deterministic pathname,
 * overwrite allowed, first catalog row wins). No database connection is held
 * while rendering or uploading. Storage and catalog failures degrade to serving
 * the fresh render without persisting it; only a failed render is an error.
 *
 * Renders take render slots, so a burst of distinct cold cards cannot start
 * more sharp pipelines than the instance has CPU for. Memory and store hits
 * never wait for a slot; a render that cannot queue is shed with
 * CardImageBusyError.
 */
export class CardImageService {
  readonly #flights = new SingleFlight<Loaded>();
  readonly #memory: ByteLruCache;
  readonly #persistence: CardImagePersistence | null;
  readonly #render: CardImageRenderer;
  readonly #renderReceipt: PresaleReceiptRenderer;
  readonly #renderQueue: number;
  readonly #renderSlots: Semaphore;

  constructor(options: CardImageServiceOptions) {
    const renderQueue = options.renderQueue ?? CARD_RENDER_QUEUE_DEFAULT;
    if (!z.number().int().nonnegative().safeParse(renderQueue).success) {
      throw new RangeError("The card render queue must be a non-negative integer.");
    }
    this.#memory = new ByteLruCache(options.memoryCacheBytes);
    this.#persistence = options.persistence;
    this.#render = options.render;
    this.#renderReceipt = options.renderReceipt ?? renderPresaleReceiptWithResvg;
    this.#renderQueue = renderQueue;
    this.#renderSlots = createSemaphore(options.renderConcurrency ?? CARD_RENDER_CONCURRENCY_DEFAULT);
  }

  get storeKind(): CardImageStoreKind | "memory" {
    return this.#persistence?.store.kind ?? "memory";
  }

  async image(input: Readonly<{
    format: CardImageFormat;
    record: unknown;
    shareStats?: ShareCardStats;
  }>): Promise<CardImage> {
    const started = performance.now();
    const { format } = input;
    try {
      if (!(CARD_IMAGE_FORMATS as readonly unknown[]).includes(format)) {
        throw new TypeError("Unknown card image format.");
      }
      const shareStats = format === "share"
        ? createShareCardStats(input.shareStats ?? { recruitHandles: [], recruitTotal: 0 })
        : undefined;
      const { digest, record } = cardImageIdentity(input.record, shareStats);
      const key: CardImageKey = { cardId: record.cardId, digest, format };
      const catalog = this.#persistence?.catalog;
      const { loaded, shared } = await this.#serve({
        format,
        labels: NO_LABELS,
        memoryKey: memoryKeyOf(key),
        pathname: cardImagePathname(key),
        catalog: catalog
          ? { find: () => catalog.find(key), record: (location) => catalog.record(key, location) }
          : null,
        draw: () => this.#render(record, format, shareStats),
      });
      return this.#served(key, loaded, started, shared);
    } catch (error) {
      this.#failed(error, format, started, NO_LABELS);
      throw error;
    }
  }

  /**
   * A presale receipt image (T-012), through the same memory cache, single
   * flight, render slots and object store as season-zero cards, catalogued in
   * the receipt catalog. Identical record content is one digest: one render
   * per instance, byte-identical bytes.
   */
  async receiptImage(input: Readonly<{ format: CardImageFormat; record: unknown }>): Promise<PresaleReceiptImage> {
    const started = performance.now();
    const { format } = input;
    try {
      if (!(CARD_IMAGE_FORMATS as readonly unknown[]).includes(format)) {
        throw new TypeError("Unknown card image format.");
      }
      const { digest, record } = presaleReceiptImageIdentity(input.record);
      const key: PresaleReceiptImageKey = { presaleId: record.presaleId, wallet: record.wallet, format, digest };
      const catalog = this.#persistence?.receipts;
      const { loaded, shared } = await this.#serve({
        format,
        labels: RECEIPT_LABELS,
        memoryKey: receiptMemoryKey(key),
        pathname: presaleReceiptImagePathname(key),
        catalog: catalog
          ? { find: () => catalog.find(key), record: (location) => catalog.record(key, location) }
          : null,
        draw: () => this.#renderReceipt(record, format),
      });
      this.#servedMetric(format, loaded.source, started, shared, RECEIPT_LABELS);
      return Object.freeze({
        ...key,
        ...dimensions(format),
        bytes: loaded.bytes,
        contentType: "image/png",
        source: loaded.source,
      });
    } catch (error) {
      this.#failed(error, format, started, RECEIPT_LABELS);
      throw error;
    }
  }

  async #serve(job: ImageJob): Promise<Readonly<{ loaded: Loaded; shared: boolean }>> {
    const cached = this.#memory.get(job.memoryKey);
    if (cached) return { loaded: { bytes: cached, source: "memory" }, shared: false };
    const flight = this.#flights.run(job.memoryKey, async () => {
      const result = await this.#load(job);
      this.#memory.set(job.memoryKey, result.bytes);
      return result;
    });
    return { loaded: await flight.promise, shared: flight.shared };
  }

  #failed(error: unknown, format: CardImageFormat, started: number, labels: ImageJob["labels"]): void {
    recordMetric("card.image", {
      durationMs: Math.round(performance.now() - started),
      error: errorLabel(error),
      format,
      ...labels,
      outcome: "error",
      store: this.storeKind,
    });
  }

  /**
   * The image for `key` when this instance holds it in memory, otherwise null.
   * Touches nothing else: no record, database, store, or render slot.
   */
  cached(key: CardImageKey): CardImage | null {
    const started = performance.now();
    const bytes = this.#memory.get(memoryKeyOf(key));
    return bytes ? this.#served(key, { bytes, source: "memory" }, started, false) : null;
  }

  #served(key: CardImageKey, loaded: Loaded, started: number, shared: boolean): CardImage {
    this.#servedMetric(key.format, loaded.source, started, shared, NO_LABELS);
    return Object.freeze({
      ...dimensions(key.format),
      bytes: loaded.bytes,
      cardId: key.cardId,
      contentType: "image/png",
      digest: key.digest,
      format: key.format,
      source: loaded.source,
    });
  }

  #servedMetric(
    format: CardImageFormat,
    source: CardImageSource,
    started: number,
    shared: boolean,
    labels: ImageJob["labels"],
  ): void {
    recordMetric("card.image", {
      durationMs: Math.round(performance.now() - started),
      format,
      ...labels,
      outcome: "ok",
      shared,
      source,
      store: this.storeKind,
    });
  }

  async #load(job: ImageJob): Promise<Loaded> {
    const store = this.#persistence?.store;
    const { catalog } = job;
    if (!store || !catalog) return this.#renderUnpersisted(job);

    let location: CardImageLocation | null;
    try {
      location = await catalog.find();
    } catch (error) {
      this.#storeError("lookup", error, job);
      return this.#renderUnpersisted(job);
    }
    if (location) {
      const stored = await this.#readStored(store, location, job);
      if (stored.state === "found") return { bytes: stored.bytes, source: "store" };
      if (stored.state === "failed") return this.#renderUnpersisted(job);
    }

    const bytes = await this.#renderTimed(job);
    const { pathname } = job;
    let url: string;
    try {
      ({ url } = await store.write(pathname, bytes));
    } catch (error) {
      this.#storeError("write", error, job);
      return { bytes, source: "render" };
    }
    try {
      await catalog.record({
        byteSize: bytes.byteLength,
        contentType: "image/png",
        pathname,
        url,
      });
    } catch (error) {
      this.#storeError("record", error, job);
    }
    return { bytes, source: "render" };
  }

  async #readStored(
    store: CardImageStore,
    location: CardImageLocation,
    job: ImageJob,
  ): Promise<Stored> {
    let bytes: Buffer | null;
    try {
      bytes = await store.read(location.pathname);
    } catch (error) {
      this.#storeError("read", error, job);
      return { state: "failed" };
    }
    if (bytes) return { bytes, state: "found" };
    // Catalogued but gone from the store: render and write it again.
    this.#storeError("read", { code: "object_missing" }, job);
    return { state: "missing" };
  }

  async #renderUnpersisted(job: ImageJob): Promise<Loaded> {
    return { bytes: await this.#renderTimed(job), source: "render" };
  }

  async #renderTimed(job: ImageJob): Promise<Buffer> {
    const waitStarted = performance.now();
    const release = await this.#renderSlot(job);
    try {
      return await timed("card.render", () => job.draw(), {
        format: job.format,
        ...job.labels,
        waitMs: Math.round(performance.now() - waitStarted),
      });
    } finally {
      release();
    }
  }

  async #renderSlot(job: ImageJob): Promise<Release> {
    const slots = this.#renderSlots;
    if (slots.active >= slots.limit && slots.waiting >= this.#renderQueue) {
      throw this.#shed("queue_full", job);
    }
    try {
      return await slots.acquire(RENDER_WAIT_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof SemaphoreTimeoutError) throw this.#shed("wait_timeout", job);
      throw error;
    }
  }

  #shed(reason: CardImageBusyError["reason"], job: ImageJob): CardImageBusyError {
    recordMetric("card.render.shed", {
      active: this.#renderSlots.active,
      format: job.format,
      ...job.labels,
      reason,
      waiting: this.#renderSlots.waiting,
    });
    return new CardImageBusyError(reason);
  }

  #storeError(operation: CardImageStoreOperation, error: unknown, job: ImageJob): void {
    recordMetric("card.image.store_error", {
      error: errorLabel(error),
      format: job.format,
      ...job.labels,
      operation,
      store: this.storeKind,
    });
  }
}

/** The service over `pool` with `settings` (`RuntimeConfig.cardImages`). */
export function createCardImageService(pool: Pool, settings: CardImageSettings): CardImageService {
  const store = cardImageStore(settings.store);
  return new CardImageService({
    memoryCacheBytes: settings.memoryCacheBytes,
    renderConcurrency: settings.renderConcurrency,
    renderQueue: settings.renderQueue,
    persistence: store
      ? {
          catalog: new PostgresCardImageCatalog(pool),
          receipts: new PostgresPresaleReceiptImageCatalog(pool),
          store,
        }
      : null,
    render: async (record, format, stats) => renderCardImageWithSharp(
      await upgradeCardAvatar(record, async (cardId) => {
        const result = await autocommitRead<{ x_avatar_reference: string | null }>(
          pool,
          "card",
          `SELECT profile.x_avatar_reference
           FROM mission_control_cards card
           JOIN mission_control_profiles profile ON profile.profile_id = card.profile_id
           WHERE card.card_id = $1`,
          [cardId],
        );
        return result.rows[0]?.x_avatar_reference ?? null;
      }),
      format,
      stats,
    ),
  });
}

let sharedService: CardImageService | undefined;

/**
 * The one card image service per function instance, so its memory cache and
 * in-flight renders are shared by every request the instance serves.
 */
export function missionControlCardImages(): CardImageService {
  sharedService ??= createCardImageService(primaryPool(), runtimeConfig().cardImages);
  return sharedService;
}
