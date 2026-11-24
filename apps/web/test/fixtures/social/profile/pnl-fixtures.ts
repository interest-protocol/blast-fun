import type { SocialPnl } from "@blast/core/modules/social/contracts/pnl.ts";

export const PROFILE_PNL: SocialPnl = {
  scope: "indexed_sale_coins", period: "since_launch", history_complete: true,
  wallet_sync: { status: "ready", checkpoint: "10", as_of_ms: 1_800_000_000_000 },
  totals: { realized_usd: "-130.00", unrealized_usd: "-40.00", total_usd: "-170.00" },
  assets: [
    { presale_id: `0x${"a".repeat(64)}`, coin_type: "0xa::coin::KSTL", symbol: "KSTL", icon_url: "https://i.blast.test/kstl.png", tracked_balance: "1000000", basis_usd: "240.00", realized_usd: "120.00", unrealized_usd: "-40.00", total_usd: "80.00" },
    { presale_id: `0x${"b".repeat(64)}`, coin_type: "0xb::coin::LUMN", symbol: "LUMN", icon_url: null, tracked_balance: "0", basis_usd: "0.00", realized_usd: "-250.00", unrealized_usd: "0.00", total_usd: "-250.00" },
  ],
};
