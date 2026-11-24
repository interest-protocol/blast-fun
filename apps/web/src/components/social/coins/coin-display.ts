import { shortAddress } from "@blast/core/web/format.ts";
import { normalizeStructTag } from "@mysten/sui/utils";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/web/contracts/create.ts";

/** Display aliases belong to an exact asset, never to a copied ticker. */
export function coinDisplay(coinType: string, symbol: string, name: string, network = "mainnet") {
  try {
    if (network === "mainnet" && normalizeStructTag(coinType) === normalizeStructTag(CREATE_TEST_SUI_QUOTE_TYPE))
      return { symbol: "TSUI", name: "Test SUI" };
  } catch { /* Unrecognized identities keep their supplied metadata. */ }
  return { symbol, name };
}

/** Ticker labels use a single word. Use the coin identifier or role when no ticker fits. */
export function shortTicker(symbol: string | null): string | undefined {
  const ticker = symbol?.trim();
  return ticker && !/\s/.test(ticker) ? ticker : undefined;
}

export function shortCoinType(coinType: string): string {
  const [address, ...rest] = coinType.split("::");
  return [shortAddress(address), ...rest].join("::");
}
