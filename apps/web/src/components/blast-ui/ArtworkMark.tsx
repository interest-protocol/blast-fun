"use client";

import { CoinArtwork } from "./CoinArtwork";

type MarkSize = 18 | 34 | 40 | 48 | 50 | 56 | 60 | 72 | 84;

export function ArtworkMark({ src, fallbackId, coinType, size = 40 }: Readonly<{
  src: string | null;
  fallbackId: string;
  coinType?: string;
  size?: MarkSize;
}>) {
  return <span aria-hidden="true" data-artwork-size={size}><CoinArtwork src={src} fallbackId={fallbackId} coinType={coinType} size={size} /></span>;
}
