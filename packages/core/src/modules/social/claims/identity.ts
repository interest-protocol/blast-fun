import { normalizeSuiAddress } from "@mysten/sui/utils";

import { isCreatorActionKind } from "../contracts/creator-earnings.ts";
import type { LaunchClaimKind } from "../contracts/launch-claims.ts";

import type { SocialClaimKind } from "../contracts/claims.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/** The schedule is an immutable fact of a vesting attempt, bound by the log's existing key. */
export function claimIdempotencyKey(kind: SocialClaimKind, requestId: string, scheduleId?: string | null, vaultId?: string | null): string {
  const key = `${kind}:${requestId}`;
  if (isCreatorActionKind(kind)) {
    if (!vaultId || !SUI_OBJECT_ID_PATTERN.test(normalizeSuiAddress(vaultId))) throw new TypeError("A creator action requires a vault.");
    return `${key}:${normalizeSuiAddress(vaultId)}`;
  }
  if (kind !== "claim_vesting") return key;
  if (scheduleId === undefined || scheduleId === null) throw new TypeError("A vesting claim requires a schedule.");
  const normalized = normalizeSuiAddress(scheduleId);
  if (!SUI_OBJECT_ID_PATTERN.test(normalized)) throw new TypeError("A vesting claim requires a valid schedule.");
  return `${key}:${normalized}`;
}

/** Old keys cannot prove which schedule was signed; neither a replay nor the worker may infer it. */
export function vestingScheduleFromClaimKey(key: string, requestId: string): string | null {
  const prefix = `claim_vesting:${requestId}:`;
  if (!key.startsWith(prefix)) return null;
  const schedule = key.slice(prefix.length);
  return SUI_OBJECT_ID_PATTERN.test(schedule) ? schedule : null;
}

/** The immutable vault binding of a creator action. */
export function creatorVaultFromClaimKey(kind: string, key: string, requestId: string): string | null {
  if (!isCreatorActionKind(kind)) return null;
  const prefix = `${kind}:${requestId}:`;
  const id = key.startsWith(prefix) ? key.slice(prefix.length) : "";
  return SUI_OBJECT_ID_PATTERN.test(id) ? id : null;
}

/** What a launch claim attempt is bound to: its launch, and for a vault claim the vault. */
export type LaunchClaimBinding = Readonly<{ launchId: string; vaultId: string | null }>;

/**
 * A launch claim's key, `<kind>:<request id>:<launch>`, and for `claim_launch_lp_fees`
 * `:<vault>` after it: the facts the attempt was recorded for, so a replay cannot name another.
 */
export function launchClaimIdempotencyKey(kind: LaunchClaimKind, requestId: string, binding: LaunchClaimBinding): string {
  const launchId = normalizeSuiAddress(binding.launchId);
  if (!SUI_OBJECT_ID_PATTERN.test(launchId)) throw new TypeError("A launch claim requires a launch.");
  if (kind === "claim_launch_fees") {
    if (binding.vaultId !== null) throw new TypeError("A curve fee claim names no vault.");
    return `${kind}:${requestId}:${launchId}`;
  }
  const vaultId = binding.vaultId === null ? "" : normalizeSuiAddress(binding.vaultId);
  if (!SUI_OBJECT_ID_PATTERN.test(vaultId)) throw new TypeError("A vault fee claim requires a vault.");
  return `${kind}:${requestId}:${launchId}:${vaultId}`;
}

/** The launch (and vault) a launch claim's key binds, or null for a key of another shape. */
export function launchClaimBindingFromKey(kind: string, key: string, requestId: string): LaunchClaimBinding | null {
  const prefix = `${kind}:${requestId}:`;
  if (!key.startsWith(prefix)) return null;
  const [launchId, vaultId, ...rest] = key.slice(prefix.length).split(":");
  if (rest.length > 0 || launchId === undefined || !SUI_OBJECT_ID_PATTERN.test(launchId)) return null;
  if (kind === "claim_launch_fees") return vaultId === undefined ? { launchId, vaultId: null } : null;
  if (kind === "claim_launch_lp_fees") return vaultId !== undefined && SUI_OBJECT_ID_PATTERN.test(vaultId) ? { launchId, vaultId } : null;
  return null;
}
