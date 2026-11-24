"use client";

import type { CSSProperties } from "react";

import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE, CREATE_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";

import { CoinArtwork } from "./CoinArtwork";
import { coinArtworkIdentity } from "./coin-artwork-identity";
import { identityBackground } from "./identity-gradient.ts";

type CoinMarkIdentity = Readonly<{
  key: string;
  iconUrl: string | null;
  round?: boolean;
  symbol?: string;
  coinType?: string;
  network?: string;
}>;

/**
 * A coin's mark: USDC's and SUI's logos (round), a presale coin's icon
 * (square), as the design's `mark` draws them. R3-07: each carries its own
 * key as `mk-<key>`, so one coin's mark can be styled on its own. R3-33's
 * coin header draws the gate's default 44 px mark; Portfolio's coin rows and
 * Rewards' rows the gate's `s40` (OA-44, OA-46).
 */
export function CoinMark({ coin, size = 34 }: Readonly<{ coin: CoinMarkIdentity; size?: 16 | 18 | 22 | 28 | 30 | 32 | 34 | 40 | 44 | 55 }>) {
  const type = coin.coinType ?? (coin.key === "sui" ? CREATE_SUI_QUOTE_TYPE : coin.key === "usdc" ? CREATE_QUOTE_TYPE : coin.key);
  const network = coin.network ?? "mainnet";
  const round = network === "mainnet" && (!!coreCoin(type) || coinArtworkIdentity(type, "") === coinArtworkIdentity(CREATE_TEST_SUI_QUOTE_TYPE, ""));
  // The generated mark shows behind a logo until it decodes, so a slow or silently failed image is never a blank slot.
  const fallback = { "--coin-fallback": identityBackground(coinArtworkIdentity(type, coin.key, network)) } as CSSProperties;
  return <span aria-hidden="true" className={`mk-${coin.key}`} data-coin-mark="" data-coin-size={size} data-coin-round={round || undefined} style={fallback}><CoinArtwork coinType={type} network={network} fallbackId={coin.key} src={coin.iconUrl} size={size} /></span>;
}
