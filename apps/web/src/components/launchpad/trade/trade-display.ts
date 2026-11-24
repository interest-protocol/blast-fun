import { sellPresetAtoms, type SellPreset } from "#web/components/social/trade/trade-ticket.ts";
import { amtExact } from "@blast/core/web/exact-amount.ts";
import { parseFormattedAtomic } from "./amount.ts";
import type { QuoteAsset } from "./quote-asset.ts";
import { atomsGrouped } from "@blast/core/web/format.ts";

/** Only compact amounts with known units; transaction/review values stay exact. */
export function compactTradeText(text: string, asset: Readonly<{ symbol: string; decimals: number; quote: QuoteAsset }> | null): string {
  if (!asset || asset.symbol === asset.quote.symbol) return text;
  return text.replace(/(\d[\d,]*(?:\.\d+)?) ([^\s;,]+)/g, (match, raw: string, unit: string) => {
    const decimals = unit === asset.symbol ? asset.decimals : unit === asset.quote.symbol ? asset.quote.decimals : null;
    if (decimals === null) return match;
    const atoms = parseFormattedAtomic(raw, decimals);
    return atoms === null ? match : `${amtExact({ n: atoms, scale: decimals })} ${unit}`;
  });
}

/** Preserve Max's exact atoms, including balances beyond the typed field's display precision. */
export function tradePresetAmount(preset: SellPreset, balance: bigint, decimals: number): string {
  const coin = { atoms: balance, decimals };
  return atomsGrouped(sellPresetAtoms(preset, coin), decimals);
}

