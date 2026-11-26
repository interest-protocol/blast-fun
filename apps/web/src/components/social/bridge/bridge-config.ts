// Loaded through `lib/web-config.ts` under plain Node: relative imports and erasable TypeScript only.
import type { PresaleConfig } from "../../presale/config.ts";

type Environment = Readonly<Record<string, string | undefined>>;

/** The chains people can bridge from, in the order the chain picker lists them. */
export const BRIDGE_CHAINS = ["base", "ethereum", "arbitrum", "solana"] as const;
export type BridgeChain = (typeof BRIDGE_CHAINS)[number];

/**
 * What the browser gets for the Bridge to Sui card: the source-chain RPCs it
 * reads balances and sends through. Only chains with an RPC appear. These are
 * the presale's public RPC settings (`NEXT_PUBLIC_PRESALE_*_RPC_URL*`), already
 * validated as plain `https` URLs.
 */
export type BridgeConfig = Readonly<{ rpcs: Readonly<Partial<Record<BridgeChain, string>>> }>;

/** Mayan's quote, Blink order and explorer APIs: the only Mayan hosts our paths reach. */
export const MAYAN_ORIGINS = [
  "https://price-api.mayan.finance",
  "https://blink-api.mayan.finance",
  "https://explorer-api.mayan.finance",
] as const;

/**
 * `NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED=1` turns the card on when at least one
 * source chain has an RPC; otherwise null and no Bridge button shows anywhere.
 */
export function readBridgeConfig(environment: Environment, presale: PresaleConfig): BridgeConfig | null {
  if (environment.NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED !== "1") return null;
  const rpcs: Partial<Record<BridgeChain, string>> = {};
  const { evmRpcUrls, solanaRpcUrl } = presale.bridge;
  if (evmRpcUrls.status === "available") Object.assign(rpcs, evmRpcUrls.value);
  if (solanaRpcUrl.status === "available") rpcs.solana = solanaRpcUrl.value;
  return Object.keys(rpcs).length === 0 ? null : { rpcs };
}

/** The `connect-src` origins the card needs while it is on: Mayan and the source RPCs. */
export function bridgeConnectSources(config: BridgeConfig | null): string[] {
  if (!config) return [];
  return [...new Set([...MAYAN_ORIGINS, ...Object.values(config.rpcs).map((rpc) => new URL(rpc).origin)])];
}
