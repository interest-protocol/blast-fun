/** Renderer-independent card port shared by canonical owner logic and its image owner. */
export type CardImageFormat = "card" | "share";

export interface RenderedSeasonZeroCard {
  readonly cardId: string;
  readonly contentType: "image/png";
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
}

export interface OwnerCardImages {
  image(input: Readonly<{ format: CardImageFormat; record: unknown }>): Promise<RenderedSeasonZeroCard>;
}
