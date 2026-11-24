export const FIXTURE_WALLET_ADDRESS = "0x3f9a8c21d04b7e91a2c5f6e8b3d0794c1e2a5b6f8d9c0e1f2a3b4c5d6e7b1c21";



import { FIXTURE_MARKS } from "../profile/fixture-media.ts";

import { coinView, type WalletCoinView } from "#web/components/social/coins/coin-model.ts";

import type { SwapFixtureMode } from "./swap-fixture.ts";
import { tradableCoinView } from "#web/components/social/coins/swap-model.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

export const SALE = (key: "kstl" | "lumn", symbol: string, name: string, atoms: string, price: string, value: string, multiple: string) =>
  coinView({
    coin_type: `0x${"5".repeat(63)}${key === "kstl" ? "1" : "2"}::coin::${symbol}`,
    symbol,
    name,
    decimals: 9,
    atoms,
    usd_price: price,
    value_usd: value,
    icon_url: FIXTURE_MARKS[key] ?? null,
    presale: { presale_id: key, venue: "cetus", trading: true, multiple },
  });

export const FIXTURE_COINS: readonly WalletCoinView[] = [
  coinView({ coin_type: USDC_COIN_TYPE, symbol: "USDC", name: "USDC", decimals: 6, atoms: "860000000", usd_price: "1", value_usd: "860.00", icon_url: null, presale: null }),
  coinView({ coin_type: SUI_COIN_TYPE, symbol: "SUI", name: "SUI", decimals: 9, atoms: "412380000000", usd_price: "3.42", value_usd: "1410.34", icon_url: null, presale: null }),
  SALE("kstl", "KSTL", "Kestrel", "600000000000000", "0.0021", "1260.00", "4.2000"),
  SALE("lumn", "LUMN", "Lumen", "100000000000000", "0.0013", "130.00", "0.6000"),
];

/** Another trading sale's coin the sample wallet does not hold, for the picker's `More coins` (`?more=1`). */
export const FIXTURE_MORE_COINS: readonly WalletCoinView[] = [
  tradableCoinView({
    coin_type: `0x${"5".repeat(63)}3::coin::HLCN`,
    symbol: "HLCN",
    name: "Halcyon",
    decimals: 9,
    icon_url: FIXTURE_MARKS.hlcn ?? null,
    usd_price: "0.0042",
    presale_id: "hlcn",
  }),
];

/**
 * R3-30's recorded mainnet test coin (SALE_B, "BEE", migrated to a Cetus
 * pool), for the browser check that answers the page's real quote request
 * with the recorded response (`?client=real&more=bee`).
 */
export const FIXTURE_RECORDED_BEE: WalletCoinView = tradableCoinView({
  coin_type: "0x5650d58030f361f60f81913b54bf026e93e957bfbf506234f8f2e83bd3bfbd85::sale_tokens::SALE_B",
  symbol: "BEE",
  name: "BEE",
  decimals: 9,
  icon_url: null,
  usd_price: "0.00000000006",
  presale_id: `0x${"b0b".padStart(64, "0")}`,
});

/** The fixture's trading answers (R3-33): every quote shaped like R3-30's, none from the network. */
export const DEFAULT_SWAP_MODE: SwapFixtureMode = { quote: "ok", trade: "ok", signedIn: true, fee: "sponsored" };

/** The fixture's way into a state the design shows mid-flow (development only). */
export type FixtureCoinInitial = Readonly<{
  stack?: readonly import("#web/components/social/coins/coin-model.ts").CoinScreen[];
  wdAmount?: string;
  wdTo?: string;
  wdTouched?: boolean;
  busy?: "withdraw";
  /** R3-33: the trade screen's amount as typed, or the whole balance (`Max`), with the detail open. */
  tradeAmount?: string;
  tradeWhole?: boolean;
  tradeDetail?: boolean;
  /** R3-33: the trade mid-flow (`Trading`, a failure's words, the fee prompt). */
  trade?: Readonly<{ busy?: boolean; failure?: string; feeMist?: string; quote?: import("@blast/core/modules/social/contracts/trades.ts").SocialTradeQuote }>;
  /** R3-33: the picker's search as typed. */
  pickQuery?: string;
}>;
