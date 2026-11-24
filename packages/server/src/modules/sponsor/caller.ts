/**
 * Who asks for gas: a Privy account (its embedded wallet signs) or an outside
 * Sui wallet's sign-in session (Slush and the other wallets; owner ruling
 * 2026-11-20 reversed OA-17: Blast pays their gas too). A social caller
 * passes as it is.
 */
export type SponsorCaller =
  | Readonly<{ kind: "privy"; did: string }>
  | Readonly<{ kind: "wallet"; address: string }>;

/**
 * The key the sponsor's reservations, executions and per-account budgets are
 * counted under: the Privy DID, or `sui:<address>` for a wallet session (the
 * social kit's subject). Stores keep it in their `privy_did` column.
 */
export function sponsorAccountKey(caller: SponsorCaller): string {
  return caller.kind === "privy" ? caller.did : `sui:${caller.address}`;
}

/** The sponsor caller of an `account_or_wallet` presale route; null when neither credential signed in. */
export function routeSponsorCaller(
  context: Readonly<{ account: Readonly<{ did: string }> | null; wallet: Readonly<{ address: string }> | null }>,
): SponsorCaller | null {
  if (context.account) return { kind: "privy", did: context.account.did };
  if (context.wallet) return { kind: "wallet", address: context.wallet.address };
  return null;
}
