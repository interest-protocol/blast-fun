import type { AllowlistEntriesResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { atomsText } from "@blast/core/web/format.ts";


export function savedAllowlistCsv(list: AllowlistEntriesResponse, decimals: number): string {
  return "address,amount\n" + list.entries.map((entry) => `${entry.wallet},${atomsText(entry.cap, decimals)}`).join("\n") + "\n";
}

export function originalAllowlistCsv(list: AllowlistEntriesResponse): string {
  if (!list.source) throw new Error("Replace this older list before changing card-holder inclusion.");
  return "wallet,cap\n" + list.entries.slice(0, list.source.uploaded_count).map((entry) => `${entry.wallet},${entry.cap}`).join("\n") + "\n";
}
