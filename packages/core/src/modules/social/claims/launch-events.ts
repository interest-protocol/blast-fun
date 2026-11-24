import { launchpadEventBcs } from "@interest-protocol/blast-sdk/launchpad";
import { vaultEventBcs } from "@interest-protocol/blast-sdk/vault";
import { fromBase64, normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

/** The launchpad's and the vault's original package ids, where their events live. */
export type LaunchClaimPackages = Readonly<{ launchpad: string; vault: string }>;

/** One creator fee claim a transaction emitted: the curve's for a launch, or a vault's. */
export type LaunchClaimEvent =
  | Readonly<{ kind: "claim_launch_fees"; launchId: string }>
  | Readonly<{ kind: "claim_launch_lp_fees"; vaultId: string }>;

type EventEvidence = Readonly<{ eventType: string; bcs: Uint8Array | string }>;

const bytesOf = (bcs: Uint8Array | string) => (typeof bcs === "string" ? fromBase64(bcs) : bcs);

function curveClaim(tag: ReturnType<typeof parseStructTag>, event: EventEvidence, launchpad: string): LaunchClaimEvent | null {
  if (tag.address !== launchpad || tag.module !== "events" ||
    tag.name !== "CreatorFeesClaimed" || tag.typeParams.length !== 2) return null;
  const parsed = launchpadEventBcs.CreatorFeesClaimed.parse(bytesOf(event.bcs));
  return { kind: "claim_launch_fees", launchId: normalizeSuiAddress(parsed.launch_id) };
}

function vaultClaim(tag: ReturnType<typeof parseStructTag>, event: EventEvidence, vault: string): LaunchClaimEvent | null {
  if (tag.address !== vault || tag.module !== "blast_vault_events" ||
    tag.name !== "OwnerBalancesClaimed" || tag.typeParams.length !== 2) return null;
  const parsed = vaultEventBcs.OwnerBalancesClaimed.parse(bytesOf(event.bcs));
  return { kind: "claim_launch_lp_fees", vaultId: normalizeSuiAddress(parsed.vault_id) };
}

/**
 * The creator fee claims among `events` (a fullnode's, or blast-infra's native evidence with
 * base64 BCS), decoded with the SDK's own layouts and only from the configured packages, so
 * another package's look-alike event never counts. An event that does not decode is skipped.
 */
export function launchClaimEvents(events: readonly EventEvidence[], packages: LaunchClaimPackages): LaunchClaimEvent[] {
  const launchpad = normalizeSuiAddress(packages.launchpad);
  const vault = normalizeSuiAddress(packages.vault);
  return events.flatMap((event) => {
    try {
      const tag = parseStructTag(event.eventType);
      const address = normalizeSuiAddress(tag.address);
      const normalized = { ...tag, address };
      const claim = curveClaim(normalized, event, launchpad) ?? vaultClaim(normalized, event, vault);
      return claim ? [claim] : [];
    } catch {
      return [];
    }
  });
}

/** Whether `events` hold the claim an attempt bound to `binding` was for. */
export function claimsBinding(
  events: readonly LaunchClaimEvent[],
  kind: LaunchClaimEvent["kind"],
  binding: Readonly<{ launchId: string; vaultId: string | null }>,
): boolean {
  return events.some((event) =>
    event.kind === "claim_launch_fees"
      ? kind === "claim_launch_fees" && event.launchId === normalizeSuiAddress(binding.launchId)
      : kind === "claim_launch_lp_fees" && binding.vaultId !== null && event.vaultId === normalizeSuiAddress(binding.vaultId),
  );
}
