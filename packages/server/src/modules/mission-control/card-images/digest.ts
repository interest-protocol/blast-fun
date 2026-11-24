import { createHash } from "node:crypto";

import {
  createSeasonZeroCardRecord,
  createShareCardStats,
  type SeasonZeroCardRecord,
  type ShareCardStats,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import {
  createPresaleReceiptRecord,
  type PresaleReceiptRecord,
} from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import { CARD_RENDERER_VERSION, PRESALE_RECEIPT_RENDERER_VERSION } from "@blast/core/modules/mission-control/card-renderer/version.ts";
import type { CardImageKey, PresaleReceiptImageKey } from "@blast/core/modules/mission-control/card-images/contracts.ts";

/**
 * JSON with object keys sorted at every level. Card records are stored as JSONB,
 * which does not keep key order, so the digest must not depend on it.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Canonical JSON cannot encode a non-finite number.");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Canonical JSON cannot encode this value.");
  return encoded;
}

export interface CardImageIdentity {
  readonly record: SeasonZeroCardRecord;
  readonly digest: string;
}

/**
 * Validates a stored record exactly as the renderer does, then names the pixels
 * it renders to: sha256 over the canonical record and the renderer version.
 */
export function cardImageIdentity(input: unknown, stats?: ShareCardStats): CardImageIdentity {
  const record = createSeasonZeroCardRecord(input);
  const shareStats = stats === undefined ? undefined : createShareCardStats(stats);
  const digest = createHash("sha256")
    .update(canonicalJson({ record, renderer: CARD_RENDERER_VERSION, shareStats }))
    .digest("hex");
  return Object.freeze({ digest, record });
}

/** Deterministic, so a lost catalog row or object heals by writing the same path again. */
export function cardImagePathname(key: CardImageKey): string {
  return `mission-control/cards/${key.cardId}/${key.format}-${key.digest}.png`;
}

export interface PresaleReceiptImageIdentity {
  readonly record: PresaleReceiptRecord;
  readonly digest: string;
}

/**
 * Validates a receipt record as the receipt renderer does, then names its
 * pixels: sha256 over the canonical record and the receipt renderer version.
 */
export function presaleReceiptImageIdentity(input: unknown): PresaleReceiptImageIdentity {
  const record = createPresaleReceiptRecord(input);
  const digest = createHash("sha256")
    .update(canonicalJson({ record, renderer: PRESALE_RECEIPT_RENDERER_VERSION }))
    .digest("hex");
  return Object.freeze({ digest, record });
}

/** Deterministic, like card paths; a separate prefix keeps receipts apart from season-zero cards. */
export function presaleReceiptImagePathname(key: PresaleReceiptImageKey): string {
  return `presale/receipts/${key.presaleId}/${key.wallet}/${key.format}-${key.digest}.png`;
}
