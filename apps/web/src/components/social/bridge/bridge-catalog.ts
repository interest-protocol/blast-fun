import { fetchTokenList, getWormholeChainIdByName, type Token } from "@mayanfinance/swap-sdk";
import { PublicKey } from "@solana/web3.js";

import type { BridgeChain } from "./bridge-config.ts";
import { CHAINS, sourceAddressKey, type SourceToken } from "./bridge-model.ts";

export async function fetchSourceTokens(chain: BridgeChain): Promise<SourceToken[]> {
  const info = CHAINS[chain];
  const standards = info.kind === "solana" ? ["spl", "spl2022"] as const : ["erc20"] as const;
  const tokens = await fetchTokenList(chain, false, [...standards]);
  const chainId = info.chainId ?? 0;
  const wormholeId = getWormholeChainIdByName(chain);
  const known = new Set(info.tokens.map((token) => sourceAddressKey(chain, token.mayan)));
  const catalog: SourceToken[] = [];
  for (const token of tokens) {
    if (token.verified !== true || token.chainId !== chainId || token.wChainId !== wormholeId) continue;
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 30) continue;
    const address = catalogAddress(chain, token);
    const symbol = token.symbol?.trim();
    if (!symbol || !address || known.has(address)) continue;
    known.add(address);
    catalog.push({
      symbol,
      name: token.name?.trim(),
      mayan: address,
      decimals: token.decimals,
      native: false,
      reserve: 0n,
      logo: secureLogo(token.logoURI),
      standard: token.standard === "spl" || token.standard === "spl2022" ? token.standard : undefined,
    });
  }
  return catalog;
}

function catalogAddress(chain: BridgeChain, token: Token): string | null {
  if (chain !== "solana") {
    return token.standard === "erc20" && /^0x[\da-f]{40}$/i.test(token.contract) && !/^0x0{40}$/i.test(token.contract)
      ? sourceAddressKey(chain, token.contract)
      : null;
  }
  if ((token.standard !== "spl" && token.standard !== "spl2022") || !token.mint || token.mint !== token.contract) return null;
  try {
    return new PublicKey(token.mint).toBase58() === token.mint ? token.mint : null;
  } catch {
    return null;
  }
}

function secureLogo(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
