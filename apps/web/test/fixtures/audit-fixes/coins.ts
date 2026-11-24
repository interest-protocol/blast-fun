import { PUBLIC_PREFERRED_COINS, type WalletCoinView } from "#web/components/social/coins/coin-model.ts";
export async function resolveVestingCoin(type: string, _signal?: AbortSignal, atoms = 0n): Promise<WalletCoinView> {
  const coin = PUBLIC_PREFERRED_COINS.find(coin => coin.coinType === type);
  if (!coin) throw new Error("Coin is not in the controlled fixture");
  return { ...coin, atoms, amount: Number(atoms) / 10 ** coin.decimals };
}
export const listVestingCoins = async () => PUBLIC_PREFERRED_COINS;
export const vestingWalletCoins = async () => [{ ...PUBLIC_PREFERRED_COINS[0]!, atoms: 100000000000n, amount: 100 }];
