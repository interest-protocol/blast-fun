import { coinDisplay } from "#web/components/social/coins/coin-display.ts";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";

import { createQuoteOf } from "@blast/core/modules/social/contracts/create.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

export type QuoteAsset = Readonly<{ coinType: string; decimals: number; symbol: string; iconUrl: string | null }>;

/** Known canonical assets need no RPC; other quotes require actual metadata, never guessed decimals. */
export async function readQuoteAsset(client: ClientWithCoreApi, quoteType: string): Promise<QuoteAsset> {
  const coinType = normalizeStructTag(quoteType);
  const known = createQuoteOf(coinType);
  if (known) return { coinType, decimals: known.decimals, symbol: coinDisplay(coinType, known.symbol, known.name).symbol, iconUrl: null };
  const { coinMetadata } = await client.core.getCoinMetadata({ coinType });
  if (!coinMetadata || !Number.isInteger(coinMetadata.decimals) || coinMetadata.decimals < 0 || coinMetadata.decimals > 19 || !coinMetadata.symbol) {
    throw new Error("The quote coin's metadata is unavailable. Trading cannot determine its amounts.");
  }
  return { coinType, decimals: coinMetadata.decimals, symbol: coinMetadata.symbol, iconUrl: coinMetadata.iconUrl ?? null };
}

export function quoteAmount(atoms: bigint, quote: QuoteAsset): string {
  return `${atomsGrouped(atoms, quote.decimals)} ${quote.symbol}`;
}

export function curveFeeValue(
  quoteFee: bigint,
  memeFee: bigint,
  quote: (amount: bigint) => string,
  coin: (amount: bigint) => string,
): string | undefined {
  const fees = [quoteFee > 0n ? quote(quoteFee) : null, memeFee > 0n ? coin(memeFee) : null];
  return fees.filter(Boolean).join(" and ") || undefined;
}
