import type { ChainPresaleRow } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { fixtureCoinType, FIXTURE_USDC } from "../../social/trade/trade-fixtures.ts";

/** Real public coin-list support requires a shown migrated sale, independently of price. */
export function supportedPortfolioAssets(now: number): readonly ChainPresaleRow[] {
  return ["KSTL", "LUMN"].map((symbol, n) => ({
    presale_id: `0x${String(n + 6).repeat(64)}`,
    sale_token: fixtureCoinType(symbol), quote_type: FIXTURE_USDC,
    sale_symbol: symbol, sale_name: symbol === "KSTL" ? "Kestrel" : "Lumen",
    sale_icon_url: "", sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6,
    lifecycle: "migrated", start_ms: now - 86400000, end_ms: now - 3600000,
    raise_target: "10000000000", min_commitment: "1000000", wallet_cap: null,
    total_commitments: "10000000000", participants: 1, venue: "cetus",
    pool_id: `0x${String(n + 8).repeat(64)}`, updated_checkpoint: 1,
  }));
}
