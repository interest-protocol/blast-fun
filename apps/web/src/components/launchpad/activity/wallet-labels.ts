import { isActivityTrade, type ActivityRow, type IndexedTradeLabel } from "@blast/core/modules/launchpad-contract/activity.ts";

export type WalletLabel = "deployer" | IndexedTradeLabel;

export const WALLET_LABELS = {
  deployer: { name: "Deployer", detail: "This wallet launched the coin." },
  whale: { name: "Whale", detail: "This trade met Blast’s large-trade threshold or the wallet held a large share of this coin when it traded." },
  sniper: { name: "Sniper", detail: "This wallet bought on the curve in the first 60 seconds of public trading." },
} as const;

export function tradeWalletLabels(row: ActivityRow, deployer: string | null): readonly WalletLabel[] {
  if (!row.actor || !isActivityTrade(row)) return [];
  return row.actor === deployer ? ["deployer", ...(row.labels ?? [])] : row.labels ?? [];
}
