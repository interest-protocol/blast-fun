import type { Pool } from "pg";

import {
  autocommitReader,
  autocommitWrite,
  type ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import type { CardImageKey, CardImageLocation, PresaleReceiptImageKey } from "@blast/core/modules/mission-control/card-images/contracts.ts";

interface CardImageRow {
  byte_size: number;
  content_type: "image/png";
  pathname: string;
  url: string;
}

/** Where each persisted render is stored. */
export interface CardImageCatalog {
  find(key: CardImageKey): Promise<CardImageLocation | null>;
  /** Idempotent: the first instance to record a key wins, later records are no-ops. */
  record(key: CardImageKey, location: CardImageLocation): Promise<void>;
}

export class CardImageRepository {
  async find(
    database: ReadableDatabase,
    key: CardImageKey,
  ): Promise<CardImageLocation | null> {
    const result = await database.read<CardImageRow>(
      `SELECT pathname, url, content_type, byte_size
       FROM mission_control_card_images
       WHERE card_id = $1 AND format = $2 AND record_digest = $3`,
      [key.cardId, key.format, key.digest],
    );
    const row = result.rows[0];
    return row
      ? {
          byteSize: row.byte_size,
          contentType: row.content_type,
          pathname: row.pathname,
          url: row.url,
        }
      : null;
  }

  /**
   * One idempotent insert, complete on its own: an autocommit statement, one
   * round trip instead of three.
   */
  async record(
    pool: Pool,
    key: CardImageKey,
    location: CardImageLocation,
  ): Promise<void> {
    await autocommitWrite(
      pool,
      "card",
      "mission_control_card_images",
      `INSERT INTO mission_control_card_images (
         card_id, format, record_digest, pathname, url, content_type, byte_size
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (card_id, format, record_digest) DO NOTHING`,
      [
        key.cardId,
        key.format,
        key.digest,
        location.pathname,
        location.url,
        location.contentType,
        location.byteSize,
      ],
    );
  }
}

/**
 * Each call is one autocommit statement, so no connection is held while a
 * card renders or uploads.
 */
export class PostgresCardImageCatalog implements CardImageCatalog {
  readonly #pool: Pool;
  readonly #repository = new CardImageRepository();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  find(key: CardImageKey): Promise<CardImageLocation | null> {
    return this.#repository.find(autocommitReader(this.#pool, "card"), key);
  }

  record(key: CardImageKey, location: CardImageLocation): Promise<void> {
    return this.#repository.record(this.#pool, key, location);
  }
}

/** Where each persisted presale receipt render is stored (T-012). */
export interface PresaleReceiptImageCatalog {
  find(key: PresaleReceiptImageKey): Promise<CardImageLocation | null>;
  /** Idempotent: the first instance to record a key wins, later records are no-ops. */
  record(key: PresaleReceiptImageKey, location: CardImageLocation): Promise<void>;
}

/**
 * `presale_receipt_images` (migration 0046), keyed (presale, wallet, format,
 * record digest): a receipt has no season-zero card, so it cannot use
 * `mission_control_card_images`. One autocommit statement per call, so no
 * connection is held while a receipt renders or uploads.
 */
export class PostgresPresaleReceiptImageCatalog implements PresaleReceiptImageCatalog {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async find(key: PresaleReceiptImageKey): Promise<CardImageLocation | null> {
    const result = await autocommitReader(this.#pool, "presale-receipts").read<CardImageRow>(
      `SELECT pathname, url, content_type, byte_size
       FROM presale_receipt_images
       WHERE presale_id = $1 AND wallet = $2 AND format = $3 AND record_digest = $4`,
      [key.presaleId, key.wallet, key.format, key.digest],
    );
    const row = result.rows[0];
    return row
      ? { byteSize: row.byte_size, contentType: row.content_type, pathname: row.pathname, url: row.url }
      : null;
  }

  async record(key: PresaleReceiptImageKey, location: CardImageLocation): Promise<void> {
    await autocommitWrite(
      this.#pool,
      "presale-receipts",
      "presale_receipt_images",
      `INSERT INTO presale_receipt_images (
         presale_id, wallet, format, record_digest, pathname, url, content_type, byte_size
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (presale_id, wallet, format, record_digest) DO NOTHING`,
      [key.presaleId, key.wallet, key.format, key.digest, location.pathname, location.url, location.contentType, location.byteSize],
    );
  }
}
