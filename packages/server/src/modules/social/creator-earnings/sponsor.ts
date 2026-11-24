import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { SponsorTransactionKind } from "@blast/core/modules/sponsor/policy.ts";
import type { CreatorActionKind } from "@blast/core/modules/social/contracts/creator-earnings.ts";

/** Extract the vault reference. Every byte is subsequently checked against a live SDK rebuild. */
export function creatorSponsorTarget(
  kind: SponsorTransactionKind,
  packages: Readonly<{ presale: string; vault: string; migrators: string }>,
): Readonly<{ kind: CreatorActionKind; vaultId: string }> | null {
  const transaction = kind.ProgrammableTransaction;
  const [first, second] = transaction?.commands ?? [];
  const call = first?.MoveCall;
  if (!call) return null;
  const ownerClaim = second?.MoveCall;
  const collect = normalizeSuiAddress(call.package) === packages.migrators &&
    (call.module === "cetus" || call.module === "bluefin") && call.function === "collect_fees";
  const claimOwner = normalizeSuiAddress(call.package) === packages.presale &&
    call.module === "blast_presale" && call.function === "prove_owner" &&
    ownerClaim && normalizeSuiAddress(ownerClaim.package) === packages.vault &&
    ownerClaim.module === "vault" && ownerClaim.function === "claim_owner_balances";
  const argument = collect ? call.arguments[0] : claimOwner ? ownerClaim.arguments[0] : null;
  const vault =
    argument?.$kind === "Input" ? transaction?.inputs[argument.Input]?.Object?.SharedObject : null;
  return vault ? { kind: collect ? "collect_fees" : "claim_residuals", vaultId: normalizeSuiAddress(vault.objectId) } : null;
}
