import { normalizeStructTag } from "@mysten/sui/utils";
import type { SocialWallet } from "@blast/core/web/contracts/coins.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/web/contracts/trades.ts";
import type { TradeFacts } from "./trade-model";
import type { CoinRecord } from "./coin-reads";
import { atLeastPow10, exactAtoms, exactDecimal, fixedExact } from "@blast/core/web/exact-amount.ts";
import { readableUsd } from "#web/lib/market-format.ts";

/** Compact terminal cells retain exact USD in their inspector, including beyond millions. */
export function terminalUsd(raw: string): string {
  const value = exactDecimal(raw.replace(/^[+-]/, ""));
  if (!value) return "—";
  const sign = value.n === 0n ? "" : raw.startsWith("-") ? "−" : raw.startsWith("+") ? "+" : "";
  for (const [power, suffix] of [[12, "T"], [9, "B"]] as const) {
    if (atLeastPow10(value, power)) return `${sign}$${fixedExact({ n: value.n, scale: value.scale + power }, 2).replace(/\.?0+$/, "")}${suffix}`;
  }
  return `${sign}${readableUsd(raw.replace(/^[+-]/, ""))}`;
}

export function coinFacts(
  coinType: string,
  coin: CoinRecord | null,
  wallet: SocialWallet | null,
  authenticated: boolean,
): TradeFacts {
  const held = walletCoin(wallet, coinType);
  const usdc = wallet?.coins?.find(
    (value) => value.coin_type === SOCIAL_TRADE_BASE_COINS.usdc,
  );
  const symbol = coin?.symbol ?? held?.symbol ?? "coin";
  const decimals = coin?.decimals ?? held?.decimals ?? null;
  const now=Date.now();
  const walletFresh=wallet != null && now >= wallet.as_of_ms && now-wallet.as_of_ms <= 120_000;
  const coinFresh=coin?.price_as_of_ms != null && now >= coin.price_as_of_ms && now-coin.price_as_of_ms <= 120_000;
  return {
    signedIn: authenticated,
    symbol,
    coinType: coinType,
    decimals,
    price: exactDecimal((walletFresh ? held?.usd_price : null) ?? (coinFresh ? coin?.price_usd : null)),
    usdc: walletBalance(wallet, SOCIAL_TRADE_BASE_COINS.usdc),
    usdcDecimals: usdc?.decimals ?? 6,
    held: walletBalance(wallet, coinType),
    heldHint: false,
  };
}

/** Both the ticket and position use the same wallet coverage rules. */
export function walletCoin(wallet: SocialWallet | null, coinType: string) {
  const type = normalizeStructTag(coinType);
  return [...(wallet?.coins ?? []), ...(wallet?.listing?.extra_coins ?? [])]
    .find(coin => normalizeStructTag(coin.coin_type) === type);
}
export function walletBalance(wallet: SocialWallet | null, coinType: string): bigint | null {
  if (!wallet?.coins) return null;
  const coin = walletCoin(wallet, coinType);
  if (coin) return exactAtoms(coin.atoms, 0)?.n ?? null;
  return wallet.listing ? null : 0n;
}
