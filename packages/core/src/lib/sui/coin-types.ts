import { normalizeStructTag, SUI_TYPE_ARG } from "@mysten/sui/utils";

/** SUI's coin type, normalized (`0x0…02::sui::SUI`). */
export const SUI_COIN_TYPE = normalizeStructTag(SUI_TYPE_ARG);

/** Mainnet native USDC's coin type, normalized. */
export const USDC_COIN_TYPE = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

/** Mainnet suiUSDT's coin type, normalized. */
export const SUI_USDT_COIN_TYPE = "0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT";
