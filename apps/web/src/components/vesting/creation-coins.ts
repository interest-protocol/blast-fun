import { SuiGrpcClient } from "@mysten/sui/grpc";
import { normalizeStructTag } from "@mysten/sui/utils";
import { SUI_MAINNET_GRPC_URL } from "@blast/core/lib/sui-mainnet.ts";
import { atomsValue } from "@blast/core/web/format.ts";
import {
  PUBLIC_PREFERRED_COINS,
  type WalletCoinView,
} from "#web/components/social/coins/coin-model.ts";
import { fetchListedTradeCoins } from "#web/components/social/coins/swap-client.ts";
import { tradableCoinView } from "#web/components/social/coins/swap-model.ts";

const client = new SuiGrpcClient({
  network: "mainnet",
  baseUrl: SUI_MAINNET_GRPC_URL,
});

/** Metadata absence is supported explicitly in atomic units; transport failures are not absence. */
export async function resolveVestingCoin(
  type: string,
  signal?: AbortSignal,
  atoms = 0n,
): Promise<WalletCoinView> {
  const coinType = normalizeStructTag(type.trim());
  const { coinMetadata: meta } = await client.core.getCoinMetadata({
    coinType,
    signal,
  });
  signal?.throwIfAborted();
  const preferred = PUBLIC_PREFERRED_COINS.find(
    (coin) => coin.coinType === coinType,
  );
  return {
    key: preferred?.key ?? coinType,
    coinType,
    symbol: meta?.symbol || coinType.split("::").at(-1)!,
    name: meta?.name || "Metadata unavailable · atomic units",
    decimals: meta?.decimals ?? 0,
    metadataAvailable: meta !== null,
    atoms,
    amount: atomsValue(atoms, meta?.decimals ?? 0) ?? 0,
    iconUrl: meta?.iconUrl ?? null,
    round: preferred?.round ?? false,
    price: null,
    value: null,
    presale: null,
  };
}

export async function vestingWalletCoins(
  owner: string,
  signal: AbortSignal,
): Promise<readonly WalletCoinView[]> {
  const balances: { coinType: string; balance: string }[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.core.listBalances({ owner, cursor, signal });
    balances.push(...page.balances);
    if (!page.hasNextPage) break;
    if (!page.cursor || page.cursor === cursor)
      throw new Error("Your balances could not finish loading. Try again.");
    cursor = page.cursor;
  } while (true);
  const coins: WalletCoinView[] = [];
  // Bound RPC fan-out for wallets with many types. An error keeps the balance read visibly unavailable.
  for (let index = 0; index < balances.length; index += 8) {
    coins.push(
      ...(await Promise.all(
        balances
          .slice(index, index + 8)
          .map((balance) =>
            resolveVestingCoin(
              balance.coinType,
              signal,
              BigInt(balance.balance),
            ),
          ),
      )),
    );
  }
  return coins;
}

export async function listVestingCoins(
  query: string | null,
  signal: AbortSignal,
  cursor?: string | null,
) {
  if (query?.includes("::")) return [await resolveVestingCoin(query, signal)];
  const page = await fetchListedTradeCoins({ q: query, cursor }, signal);
  return {
    coins: page.coins.map(tradableCoinView),
    nextCursor: page.next_cursor,
  };
}
