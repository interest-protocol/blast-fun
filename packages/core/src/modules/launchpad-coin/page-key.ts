import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";
import { COIN_TYPE_WITH_GENERICS } from "@blast/core/lib/sui/ids.ts";

export type CoinPageKey =
  | Readonly<{ kind: "launch-id"; launchId: string }>
  | Readonly<{ kind: "coin-type"; coinType: string }>;

export function parseCoinPageKey(value: string): CoinPageKey | null {
  const launchId = parseLaunchId(value);
  if (launchId) return { kind: "launch-id", launchId };
  if (value.length > 512 || !/^0x[0-9a-fA-F]{1,64}::[A-Za-z0-9_:<>, ]+$/.test(value)) return null;
  // Move allows leading underscores that the SDK validator rejects. Validate
  // their shape with a letter in that position, then normalize the real tag.
  if (!isValidStructTag(value.replace(/::_(?=\w)/g, "::A"))) return null;
  const coinType = normalizeStructTag(value);
  return coinType.length <= 512 && COIN_TYPE_WITH_GENERICS.test(coinType) ? { kind: "coin-type", coinType } : null;
}

export function coinPagePath(coinTypeOrLaunchId: string): string {
  return `/coin/${encodeURIComponent(coinTypeOrLaunchId)}`;
}
