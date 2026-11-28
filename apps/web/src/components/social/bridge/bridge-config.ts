// Loaded through `lib/web-config.ts` under plain Node: relative imports and erasable TypeScript only.

type Environment = Readonly<Record<string, string | undefined>>;

/** The chains people can bridge from, in the order the chain picker lists them. */
export const BRIDGE_CHAINS = ["base", "ethereum", "arbitrum", "optimism", "polygon", "solana"] as const;
export type BridgeChain = (typeof BRIDGE_CHAINS)[number];

/**
 * Mayan's public RPC, the one its own widget falls back to: `/<chain>` per
 * source chain (Mayan's chain names match ours). Open CORS, no key.
 */
const MAYAN_RPC = "https://front-rpc.mayan.finance";

/** Mayan's quote, Blink order, explorer and RPC hosts: the only hosts the card reaches besides the wallet. */
export const MAYAN_ORIGINS = [
  "https://price-api.mayan.finance",
  "https://blink-api.mayan.finance",
  "https://explorer-api.mayan.finance",
  MAYAN_RPC,
] as const;

/** The card reads balances and sends Solana transactions through Mayan's RPC for that chain. */
export function mayanRpc(chain: BridgeChain): string {
  return `${MAYAN_RPC}/${chain}`;
}

/** `NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED=1` turns Bridge to Sui on; anything else hides every Bridge button. */
export function readBridgeEnabled(environment: Environment): boolean {
  return environment.NEXT_PUBLIC_MAYAN_BRIDGE_ENABLED === "1";
}

/** The `connect-src` origins the card needs while it is on. */
export function bridgeConnectSources(enabled: boolean): string[] {
  return enabled ? [...MAYAN_ORIGINS] : [];
}
