import type { CommitSaleRead } from "#web/components/social/commit/commit-view.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";

export const ALON_ID = "0x1585661b0884d0a750cb58fa880ce1b9b6d8055765fafb68a787bcc5f985d86a";
export const TSUI_TYPE = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";
export const ALON_NOW = 1791871800000;
export const ALON_READ: CommitSaleRead = {
  presale: {
    presale_id: ALON_ID, name: "alon", symbol: "ALON", icon_url: "", phase: "open", venue: "bluefin",
    start_ms: 1791759095344, end_ms: 1792018295344, target_usd: null, raised_usd: null, fill_bps: 0,
    participants: 0, interested: 0, multiple: null, quote_symbol: "TSUI", quote_type: TSUI_TYPE, quote_decimals: 9,
    target_atoms: "50000000000000", raised_atoms: "0", sale_token: "0xb8335156cd8bd243329b9ead31b1a785cd53d172120a8868d750e5f436480239::alon::ALON",
    sale_decimals: 9, allowlisted: false, min_commitment_usd: null, wallet_cap_usd: null,
    min_commitment_atoms: "10000000000", wallet_cap_atoms: "55000000000000",
  },
  terms: { presale_price_usd: null, presale_price_quote: "0.000111111111111", supply: { total: "1000000000000000000" } },
  vesting: null,
};
export const TSUI: WalletCoinView = {
  key: TSUI_TYPE, coinType: TSUI_TYPE, symbol: "TSUI", name: "Test SUI", decimals: 9,
  atoms: 50000000000n, amount: 50, price: null, value: null, iconUrl: null, round: true, presale: null,
};
