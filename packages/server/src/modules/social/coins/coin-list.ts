import { z } from "zod";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";

import { coinPriority, coreCoin, PREFERRED_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import type { SocialWallet, SocialWalletCoin } from "@blast/core/modules/social/contracts/coins.ts";
import { isSmallBalance } from "@blast/core/modules/social/portfolio/small-balance.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

export function walletListParams(url: string) {
  const params = new URL(url).searchParams;
  if (!params.has("page")) return null;
  const raw = params.get("page")!;
  const search = (params.get("q") ?? "").trim().toLowerCase();
  const hideSmall = params.get("hide_small") ?? "false";
  const hideTestMarkets = params.get("hide_test_markets") === "true";
  const mode = params.get("mode") ?? "all";
  const key = params.get("key") ?? "";
  let keys: unknown;
  try { keys = JSON.parse(params.get("keys") ?? "[]"); } catch { throw new SocialRouteError("invalid_parameter"); }
  const parsedKeys = socialInput(z.array(z.string().max(512)).max(5), keys, "invalid_parameter");
  return socialInput(z.object({
    page: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().max(2147483647)),
    search: z.string().max(200), hideSmall: z.enum(["true", "false"]).transform((value) => value === "true"),
    mode: z.enum(["all", "deposit", "withdraw"]), key: z.string().max(512), keys: z.array(z.string().max(512)).max(5),
    hideTestMarkets: z.boolean(),
  }), { page: raw, search, hideSmall, mode, key, keys: parsedKeys, hideTestMarkets }, "invalid_parameter");
}

const cents = (coin: SocialWalletCoin) => coin.value_usd === null ? null : BigInt(coin.value_usd.replace(".", ""));

export function walletCoinList(wallet: SocialWallet, params: NonNullable<ReturnType<typeof walletListParams>>): SocialWallet {
  const all = wallet.coins ?? [];
  const matches = all.filter(coin => (params.mode !== "withdraw" || BigInt(coin.atoms) > 0n || coinPriority(coin.coin_type) < PREFERRED_COINS.length) &&
    (!params.hideSmall || !isSmallBalance(coin.atoms, coin.decimals, coin.coin_type)) &&
    [coin.name, coin.symbol, coin.coin_type, coreCoin(coin.coin_type)?.symbol ?? ""].some(text => text.toLowerCase().includes(params.search)));
  matches.sort((a, b) => {
    const left = cents(a), right = cents(b);
    const identity = coinPriority(a.coin_type) - coinPriority(b.coin_type) || a.coin_type.localeCompare(b.coin_type);
    if (left === null || right === null) return left === right ? identity : left === null ? 1 : -1;
    return left === right ? identity : left > right ? -1 : 1;
  });
  const page = Math.min(params.page, Math.max(1, Math.ceil(matches.length / 20)));
  const requested = new Set(params.keys);
  const sum = all.reduce((total, coin) => total + (cents(coin) ?? 0n), 0n);
  return { ...wallet, coins: wallet.coins === null ? null : matches.slice((page - 1) * 20, page * 20), listing: {
    page, total: matches.length, page_size: 20,
    value_usd: all.some(coin => coin.value_usd === null && BigInt(coin.atoms) > 0n) ? null : `${sum / 100n}.${String(sum % 100n).padStart(2, "0")}`,
    extra_coins: all.filter(coin => PREFERRED_COINS.some(preferred => preferred.coinType === coin.coin_type) || coin.coin_type === params.key || coin.presale?.presale_id === params.key || requested.has(coin.coin_type) || requested.has(coin.presale?.presale_id ?? "")),
  } };
}
