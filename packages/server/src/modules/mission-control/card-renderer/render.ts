import type { RenderedSeasonZeroCard } from "@blast/core/modules/mission-control/card-images/render-port.ts";
export type { RenderedSeasonZeroCard } from "@blast/core/modules/mission-control/card-images/render-port.ts";
import { cardAssetPath } from "@blast/server/lib/card-assets.ts";
import { renderAsync } from "@resvg/resvg-js";

import {
  createSeasonZeroCardRecord,
  type SeasonZeroCardRecord,
  type ShareCardStats,
} from "@blast/core/modules/mission-control/card-renderer/contract.ts";
import {
  CARD_PNG_HEIGHT, CARD_PNG_WIDTH, CARD_SHARE_HEIGHT, CARD_SHARE_WIDTH,
  renderSeasonZeroCardSvg, type CardImageFormat,
} from "@blast/server/modules/mission-control/card-renderer/svg.ts";


export interface CardRendererDependencies {
  readonly rasterize?: (svg: string) => Promise<Buffer>;
}

export class CardRenderError extends Error {
  readonly name = "CardRenderError";
  readonly retryable = true;
  readonly cardId: string;
  override readonly cause: unknown;

  constructor(cardId: string, cause: unknown) {
    super(`Card ${cardId} could not be rendered; retry with the unchanged record.`);
    this.cardId = cardId;
    this.cause = cause;
  }
}

async function rasterize(svg: string, format: CardImageFormat): Promise<Buffer> {
  // Keep the canonical x-post filter intact. resvg 2.6.2 can panic when nested
  // filters fall outside its canvas; a three-sigma gutter also preserves the
  // off-canvas colours sampled by the 80px blur. Crop only after rendering.
  const padding = 240;
  const share = format === "share";
  const width = CARD_SHARE_WIDTH;
  const height = CARD_SHARE_HEIGHT;
  const renderSvg = share ? svg.replace(
    `width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`,
    `width="${width + padding * 2}" height="${height + padding * 2}" ` +
      `viewBox="${-padding} ${-padding} ${width + padding * 2} ${height + padding * 2}"`,
  ) : svg;
  const image = await renderAsync(renderSvg, {
    crop: share ? { left: padding, top: padding, right: padding + width, bottom: padding + height } : undefined,
    font: {
      // Explicit font files: serverless hosts need not have any system fonts.
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
      fontFiles: ["Medium", "SemiBold", "Bold", "ExtraBold", "Black",
        "BoldItalic", "ExtraBoldItalic", "BlackItalic"].map((weight) =>
        cardAssetPath(`fonts/Inter-${weight}.ttf`)),
    },
  });
  return image.asPng();
}

/**
 * Rendering is a pure derivative operation. It never persists or mutates identity
 * state, and CardRenderError explicitly allows a retry with the same record.
 */
export async function renderSeasonZeroCardPng(
  input: SeasonZeroCardRecord,
  dependencies: CardRendererDependencies = {},
  format: CardImageFormat = "card",
  stats: ShareCardStats = { recruitHandles: [], recruitTotal: 0 },
): Promise<RenderedSeasonZeroCard> {
  const record = createSeasonZeroCardRecord(input);
  const svg = renderSeasonZeroCardSvg(record, format, stats);

  try {
    const bytes = dependencies.rasterize
      ? await dependencies.rasterize(svg)
      : await rasterize(svg, format);
    return Object.freeze({
      cardId: record.cardId,
      contentType: "image/png",
      width: format === "share" ? CARD_SHARE_WIDTH : CARD_PNG_WIDTH,
      height: format === "share" ? CARD_SHARE_HEIGHT : CARD_PNG_HEIGHT,
      bytes,
    });
  } catch (cause) {
    throw new CardRenderError(record.cardId, cause);
  }
}
