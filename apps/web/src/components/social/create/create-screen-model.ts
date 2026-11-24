import type { SocialMeAccount } from "@blast/core/web/contracts/me.ts";

/** The creator's publishing wallet: the Blast wallet first, then Slush, then any other. */
function publishingWallet(account: SocialMeAccount | null) {
  const wallets = account?.wallets ?? [];
  return wallets.find((wallet) => wallet.kind === "embedded") ?? wallets.find((wallet) => wallet.kind === "slush") ?? wallets[0] ?? null;
}

/** The creator's own wallet for the "You" row: the Blast wallet first, then Slush, then any other. */
export function selfAddressOf(account: SocialMeAccount | null): string | null {
  return publishingWallet(account)?.address ?? null;
}

/**
 * Who pays publishing's network fees (`create-publish-wallet.ts`): Blast
 * sponsors every publishing wallet, the Blast (embedded) wallet and a wallet
 * session's alike (owner ruling 2026-11-20). Null without a wallet.
 */
export function networkFeesOf(account: SocialMeAccount | null): "blast" | "wallet" | null {
  return publishingWallet(account) === null ? null : "blast";
}
