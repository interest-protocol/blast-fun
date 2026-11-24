import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { walletBalance, walletCoin } from "./coin-facts";
import type { TradeFacts } from "./trade-model";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { exactDecimal } from "@blast/core/web/exact-amount.ts";

export type Choice = Readonly<{coin:WalletCoinView}>;

export function counterFacts(choice:Choice,wallet:SocialWallet|null,now=Date.now()):NonNullable<TradeFacts["counter"]> {
  const held=walletCoin(wallet,choice.coin.coinType);
  const walletFresh=wallet != null && now >= wallet.as_of_ms && now-wallet.as_of_ms <= 120_000;
  // USDC is the existing contract's face-value USD asset. Catalog prices carry no as-of proof.
  const price=choice.coin.coinType === USDC_COIN_TYPE ? "1" : walletFresh && held ? held.usd_price : null;
  return {coinType:choice.coin.coinType,symbol:choice.coin.symbol,decimals:held?.decimals ?? choice.coin.decimals,
    balance:walletBalance(wallet,choice.coin.coinType),
    price:exactDecimal(price)};
}
