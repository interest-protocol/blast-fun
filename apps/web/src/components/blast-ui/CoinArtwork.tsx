"use client";

import { coinArtworkIdentity } from "./coin-artwork-identity";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { IdentityGradient } from "./IdentityGradient";
import { coinLogoUrl, useCoinImages } from "./coin-images";

/** One image policy and deterministic fallback across every coin surface. */
export function CoinArtwork({ coinType, fallbackId, network = "mainnet", src, size = 34 }: Readonly<{
  coinType?: string; fallbackId: string; network?: string; src: string | null; size?: number;
}>) {
  const images = useCoinImages();
  const identity = coinArtworkIdentity(coinType, fallbackId, network);
  const canonical = network === "mainnet" ? coreCoin(coinType ?? fallbackId) : undefined;
  if (canonical?.symbol === "SUI" || canonical?.symbol === "USDC") return <svg height={size} viewBox="0 0 48 48" width={size}>
    {canonical.symbol === "SUI" ? <><rect fill="#fff" height="48" width="48" /><image height="28" href="/blast-ui/coins/sui.svg" width="21.9" x="13.1" y="10" /></> : <image height="48" href="/blast-ui/coins/usdc.svg" width="48" />}
  </svg>;
  const url = coinLogoUrl(src, canonical?.logoUrl, images.failed);
  if (url) return (
    // Public metadata can use any HTTPS host; image dimensions are reserved by the mark.
    // The image stays transparent until it has decoded (`data-coin-img` in blast-ui.css): a failure the
    // browser reports late, or not at all, leaves an empty mark instead of the broken-image glyph.
    // eslint-disable-next-line @next/next/no-img-element
    <img alt="" data-coin-img="" decoding="async" height={size} key={url} width={size} src={url} referrerPolicy="no-referrer"
      onError={() => images.fail(url)} onLoad={event => { event.currentTarget.dataset.ready = ""; }} ref={image => { if (image?.complete) imageSettled(image, url, images.fail); }} />
  );
  if (identity === coinArtworkIdentity(CREATE_TEST_SUI_QUOTE_TYPE, "", "mainnet"))
    return <span data-coin-monogram="">T</span>;
  return <svg aria-hidden="true" data-generated="" height={size} width={size} viewBox="0 0 1 1"><IdentityGradient identity={identity} /></svg>;
}

/** An image that finished before React attached its handlers: shown when it decoded to pixels, else a failure. */
function imageSettled(image: HTMLImageElement, url: string, fail: (url: string) => void): void {
  if (image.naturalWidth > 0) image.dataset.ready = "";
  else fail(url);
}
