import type { PoolTrade } from "@blast/core/modules/launchpad-contract/venue-history.ts";

export type CandleTrade = Readonly<{
  poolKey: string;
  bucketStart?: number;
  receivedAt: number;
  trade: Pick<PoolTrade, "cursor" | "timestampMs" | "price" | "memeAmount" | "side">;
}>;
