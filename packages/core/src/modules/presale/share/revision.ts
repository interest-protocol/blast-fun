import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";


/** New fundraising figures and artwork must also invalidate external social-card caches. */
export function presaleShareRevision(sale: SocialPresaleSummary): string {
  const content = JSON.stringify([
    sale.presale_id, sale.name, sale.symbol, sale.metadata?.tagline, sale.icon_url, sale.metadata?.cover?.url,
    sale.raised_atoms, sale.target_atoms, sale.raised_usd, sale.target_usd, sale.quote_symbol, sale.quote_decimals,
  ]);
  return `3-${bytesToHex(sha256(utf8ToBytes(content))).slice(0, 16)}`;
}
