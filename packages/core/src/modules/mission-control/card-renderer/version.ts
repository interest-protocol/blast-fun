/**
 * Names the pixels a card record renders to. Persisted card images are keyed by
 * a digest of the record and this value, so bump it whenever the artwork,
 * edition backgrounds, SVG layout, fonts, or rasterizer settings change; old
 * renders are then left behind instead of being served for the new artwork.
 */
export const CARD_RENDERER_VERSION = "season-zero-card-renderer/8" as const;

/**
 * Names the pixels a presale receipt record renders to (presale-receipt-svg.ts).
 * Receipt images are keyed by a digest of the record and this value; bump it
 * whenever the receipt layout, fonts or rasterizer settings change.
 */
export const PRESALE_RECEIPT_RENDERER_VERSION = "presale-receipt-renderer/1" as const;
