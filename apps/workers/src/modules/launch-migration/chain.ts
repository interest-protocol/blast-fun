// Whether a digest of ours emitted the launchpad's `Migrated` for a launch (or
// the node cannot say yet). The launch, its currencies and Bluefin's fee are
// read through the keeper jobs' shared reads (`blast-keeper/chain.ts`).

import { decodeLaunchpadEvent } from "@interest-protocol/blast-launchpad-sdk";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import { normalizeSuiObjectId } from "@mysten/sui/utils";

import { readDigestOutcome } from "../worker-runtime/outcome.ts";
import type { Provider } from "../worker-runtime/provider.ts";

/**
 * What a digest says about who migrated a launch: `ours` when it succeeded
 * and emitted this deployment's launchpad `Migrated` for the launch;
 * `not-ours` when the node answers that it did not (it failed, emitted no
 * such event, or the node has no such transaction); `unknown` when the node
 * could not answer (the lookup failed or ran out of time).
 */
export type DigestAttribution = "ours" | "not-ours" | "unknown";

/**
 * The launches a digest migrated: those it emitted this deployment's
 * launchpad `Migrated` for, empty when it failed or the node has no such
 * transaction, `unknown` when the node could not answer. One read for every
 * launch a batch carried.
 */
export async function launchesMigratedBy(
  client: ClientWithCoreApi,
  digest: string,
  launchpadOriginalPackageId: string,
  provider: Provider,
): Promise<ReadonlySet<string> | "unknown"> {
  const outcome = await readDigestOutcome(client, provider, digest, { effects: true, events: true });
  // The lookup failed or ran out of time, or the effects name another digest (a node fault): it could not say.
  if (outcome.kind === "unknown" || outcome.kind === "other-effects") return "unknown";
  const migrated = new Set<string>();
  // Failed, or the node's own answer that it has no such transaction: nothing of ours ran under it.
  if (outcome.kind !== "executed") return migrated;
  const { transaction } = outcome;
  if (transaction.checkpoint === null) return migrated;
  for (const [eventIndex, event] of (transaction.events ?? []).entries()) {
    try {
      const decoded = decodeLaunchpadEvent(
        { ...event, checkpoint: transaction.checkpoint, transactionDigest: transaction.digest, eventIndex },
        { originalPackageId: launchpadOriginalPackageId },
      );
      if (decoded.kind === "Migrated") migrated.add(normalizeSuiObjectId(decoded.payload.launch_id));
    } catch {
      // Not a launchpad event of this lineage.
    }
  }
  return migrated;
}

export async function migratedBy(
  client: ClientWithCoreApi,
  digest: string,
  launchId: string,
  launchpadOriginalPackageId: string,
  provider: Provider,
): Promise<DigestAttribution> {
  const migrated = await launchesMigratedBy(client, digest, launchpadOriginalPackageId, provider);
  if (migrated === "unknown") return "unknown";
  return migrated.has(normalizeSuiObjectId(launchId)) ? "ours" : "not-ours";
}
