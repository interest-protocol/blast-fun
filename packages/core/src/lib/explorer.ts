import type { SocialExplorer } from "@blast/core/modules/social/contracts/settings.ts";

/**
 * Transaction and account links on the explorer the viewer chose
 * (Settings → Transactions → Explorer; `useDevicePrefs().explorer`). Mainnet
 * only. Each returns null for a value that is not a digest or an address,
 * so a caller never links to a malformed path.
 */
const DIGEST = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS = /^0x[0-9a-fA-F]{1,64}$/;

export const EXPLORER_NAMES: Readonly<Record<SocialExplorer, string>> = { suiscan: "Suiscan", suivision: "SuiVision" };

export function explorerTransactionUrl(explorer: SocialExplorer, digest: string): string | null {
  if (!DIGEST.test(digest)) return null;
  return explorer === "suivision"
    ? `https://suivision.xyz/txblock/${digest}`
    : `https://suiscan.xyz/mainnet/tx/${digest}`;
}

export function explorerAccountUrl(explorer: SocialExplorer, address: string): string | null {
  if (!ADDRESS.test(address)) return null;
  return explorer === "suivision"
    ? `https://suivision.xyz/account/${address}`
    : `https://suiscan.xyz/mainnet/account/${address}`;
}
