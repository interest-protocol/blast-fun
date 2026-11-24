import { CARD_RENDERER_VERSION } from "@blast/core/modules/mission-control/card-renderer/version.ts";
import type { RenderedSeasonZeroCard, CardImageFormat } from "./render-port.ts";
import type { SeasonZeroCardRecord } from "../card-renderer/contract.ts";

export interface PublishedCardSnapshot {
  readonly record: SeasonZeroCardRecord;
  readonly recruitHandles: readonly string[];
  readonly recruitTotal: number;
}

export type { CardImageFormat };

export const CARD_IMAGE_FORMATS = ["card", "share"] as const satisfies readonly CardImageFormat[];

/**
 * The URL the app emits for a card's public image. The route reads `format`;
 * `v` makes the CDN and crawlers treat each renderer version as a new image.
 */
export function publicCardImagePath(
  cardId: string,
  format: "card" | "share" = "share",
  recruitTotal?: number,
): string {
  return `/card/${cardId.toLowerCase()}/image?${new URLSearchParams({
    ...(format === "card" ? { format } : {}),
    ...(format === "share" && recruitTotal !== undefined
      ? { recruits: String(recruitTotal) }
      : {}),
    v: CARD_RENDERER_VERSION,
  })}`;
}

/** Where a served image came from: this instance's memory, object storage, or a fresh render. */
export type CardImageSource = "memory" | "store" | "render";

/** One persisted render: a card's record, in one format, at one renderer version. */
export interface CardImageKey {
  readonly cardId: string;
  readonly format: CardImageFormat;
  /** sha256 of the canonical record and the renderer version. */
  readonly digest: string;
}

export interface CardImage extends RenderedSeasonZeroCard {
  readonly digest: string;
  readonly format: CardImageFormat;
  readonly source: CardImageSource;
}

export { CARD_IMAGE_RETRY_AFTER_SECONDS, CardImageBusyError } from "@blast/core/modules/mission-control/card-images/errors.ts";

/** The catalog row that says where a render's bytes are stored. */
export interface CardImageLocation {
  readonly pathname: string;
  readonly url: string;
  readonly contentType: "image/png";
  readonly byteSize: number;
}

/** One persisted presale receipt render (T-012): a wallet's receipt, in one format, at one renderer version. */
export interface PresaleReceiptImageKey {
  readonly presaleId: string;
  readonly wallet: string;
  /** `card`, or `share` for the route's `post`. */
  readonly format: CardImageFormat;
  /** sha256 of the canonical receipt record and the receipt renderer version. */
  readonly digest: string;
}

export interface PresaleReceiptImage extends PresaleReceiptImageKey {
  readonly contentType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
  readonly source: CardImageSource;
}

/** A new renderer version also gives social crawlers a fresh page URL. */
export function publicCardSharePath(cardId: string, recruitTotal?: number): string {
  return `/card/${cardId}?${new URLSearchParams({
    ...(recruitTotal !== undefined ? { recruits: String(recruitTotal) } : {}),
    v: CARD_RENDERER_VERSION,
    social: "2",
  })}`;
}
