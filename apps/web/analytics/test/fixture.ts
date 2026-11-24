import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import type { AuthConfig } from "../src/auth.ts";

export const token = "fixture-private-api-token-32-bytes";
export const code = "a".repeat(43);
export const hash = "b".repeat(64);
export const now = 1_800_000_000_000;
export function payload() {
  return {
    version: 2 as const,
    volumeMethod: "registered-pool-quote-receipts-v1" as const,
    volumeUnit: "registered-pool-turnover-usd" as const,
    pricingPolicy: "historical-quote-oracle-60s-100bps-v1" as const,
    auditedTotalTradeVolumeUsd: null,
    quoteTotals: { SUI: "9007199254740993" },
    asOfCheckpoint: "9007199254740993",
    asOfTimestampMs: String(now),
    windowEndExclusiveMs: String(now + 1),
    coverageStartCheckpoint: "10",
    coverageStartTimestampMs: String(now - 86_400_000),
    historyScope: "since-configured-checkpoint" as const,
    catchingUp: false,
    transactionScope: "selected-launch-presale-trade-facts" as const,
    users: {
      unit: "active-wallets" as const,
      dau24h: "2",
      mau30d: "3",
      uniqueSinceCoverage: "4",
      productDau: null,
      productMau: null,
    },
    accountActivity: null,
    totals: {
      trade_volume: {
        count: "2",
        pricedCount: "1",
        pricedUsd: "9007199254740993.123456789012345678",
      },
      launched_coins: { count: "1", pricedCount: "0", pricedUsd: "0" },
      transactions: { count: "2", pricedCount: "0", pricedUsd: "0" },
    },
    volumeWindows: {
      "24h": {
        receipts: "2",
        priced_receipts: "1",
        priced_usd: "9007199254740993.123456789012345678",
      },
      "30d": {
        receipts: "2",
        priced_receipts: "1",
        priced_usd: "9007199254740993.123456789012345678",
      },
    },
    dailyTradeVolume: [
      {
        day_ms: "1799971200000",
        receipts: "2",
        priced_receipts: "1",
        priced_usd: "9007199254740993.123456789012345678",
      },
    ],
  };
}
export const envelope = () => ({
  ...payload(),
  generatedAt: new Date(now).toISOString(),
  stale: false,
});
export async function serve(make: (config: AuthConfig) => RequestListener) {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = { origin, key: Buffer.alloc(32, 7), secure: false };
  server.on("request", make(config));
  return {
    origin,
    config,
    server,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
