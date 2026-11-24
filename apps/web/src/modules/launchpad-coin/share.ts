import type { Metadata } from "next";
import { launchCoinType } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { coinTypeName } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { SITE_NAME, SITE_ORIGIN } from "#web/lib/site.ts";
import type { readCoinRoute } from "./read.ts";

export const COIN_SHARE_WIDTH = 1200;
export const COIN_SHARE_HEIGHT = 630;
const JOEY_COIN_TYPE = "0xbcd73dc8d774982c2da4e07cd1c6803ec29e128821d1ade9e9a7ce4975b44944::joey::JOEY";

export function coinShareIdentity(resolved: Awaited<ReturnType<typeof readCoinRoute>>) {
  if (resolved.kind === "generic") {
    const { coinType, name, symbol, iconUrl } = resolved;
    return { coinType, name, symbol, iconUrl: iconUrl ?? coreCoin(coinType)?.logoUrl ?? null, canonical: coinPagePath(coinType) };
  }
  if (resolved.kind !== "launch") return null;
  const { read, details } = resolved.transfer;
  if (read.kind !== "coin" || !read.page.confirmed) return null;

  const { curve } = read.page;
  const metadata = curve.state === "available" || curve.state === "stale" ? curve.data.launch.metadata : null;
  const coinType = launchCoinType(read.page);
  const symbol = metadata?.symbol?.trim() || (coinType ? coinTypeName(coinType, 64) : "COIN");
  return {
    coinType,
    name: metadata?.name?.trim() || symbol,
    symbol,
    iconUrl: metadata?.iconUrl || details?.iconUrl || null,
    canonical: coinPagePath(coinType ?? resolved.launchId),
  };
}

export function coinShareMetadata(coin: { coinType: string | null; name: string; symbol: string; canonical: string }): Metadata {
  const { canonical } = coin;
  const title = `${coin.name} (${coin.symbol})`;
  const description = `Explore ${coin.name} on Blast.`;
  const pageUrl = new URL(canonical, SITE_ORIGIN).href;
  const image = {
    url: `${pageUrl}/share-image?v=2`,
    alt: `${coin.name} on Blast`,
    width: COIN_SHARE_WIDTH,
    height: COIN_SHARE_HEIGHT,
    type: "image/png",
  };
  const twitter = { title, description, site: "@blastdotfun" };

  return {
    title,
    description,
    alternates: { canonical },
    openGraph: { type: "website", title, description, url: pageUrl, siteName: SITE_NAME, images: [image] },
    twitter: coin.coinType === JOEY_COIN_TYPE
      ? {
          ...twitter,
          card: "summary",
          images: [{ url: new URL("/share/joey-x.jpg", SITE_ORIGIN).href, alt: "JOEY coin icon" }],
        }
      : { ...twitter, card: "summary_large_image", images: [image] },
  };
}
