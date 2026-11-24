import { requestWorkSignal } from "@blast/server/lib/request-work.ts";
import type { HoldersSnapshotPage } from "@blast/core/modules/launchpad-contract/holders.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import type { V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import type { HolderProof } from "@blast/server/modules/launchpad-social/contracts.ts";

/** Proves, or fails to prove, that `wallet` holds the coin of launch `launchId`. Never throws for an outage. */
export interface HolderProofPort {
  prove(launchId: string, wallet: string): Promise<HolderProof>;
}

export type SnapshotHolderProofDependencies = Readonly<{
  /** The launch's coin type from the canonical launch views, or null when it is not a canonical launch. */
  coinTypeOf(launchId: string): Promise<string | null>;
  /** One holder snapshot page (T-027's `readHoldersSnapshot`), from the first page or `cursor`. */
  readPage(
    coinType: string,
    launchId: string,
    cursor: string | null,
  ): Promise<RoutedRead<V1Answer<HoldersSnapshotPage>>>;
  /** How many pages of holders to read before giving up (`unavailable`). */
  maxPages: number;
  /** Retain the actual lookup/page work after its visible proof deadline. */
  trackWork?<T>(promise: Promise<T>): Promise<T>;
  /** One deadline for the whole proof, every read included; past it the proof is `unavailable`. */
  deadlineMs: number;
}>;

const UNAVAILABLE: HolderProof = Object.freeze({ verification: "unavailable" });

/**
 * A holder proof over blast-infra's native holder snapshot: the wallet is a
 * `verified_holder` when it appears with a balance on a complete (or behind)
 * snapshot, and `not_holder` when every page of one snapshot checkpoint was
 * read without it; both carry that snapshot's checkpoint and time. Anything
 * else is `unavailable`, never a guess: an incomplete snapshot, an
 * unavailable or refused read, pages from different checkpoints, more pages
 * than `maxPages`, any failure, or the deadline passing first.
 */
export function snapshotHolderProof(
  dependencies: SnapshotHolderProofDependencies,
): HolderProofPort {
  async function attempt(
    launchId: string,
    wallet: string,
    expired: () => boolean,
  ): Promise<HolderProof> {
    if (expired() || requestWorkSignal()?.aborted) return UNAVAILABLE;
    const coinType = await dependencies.coinTypeOf(launchId);
    if (coinType === null) return UNAVAILABLE;
    let cursor: string | null = null;
    let checkpoint: number | null = null;
    for (
      let page = 0;
      page < dependencies.maxPages &&
      !expired() &&
      !requestWorkSignal()?.aborted;
      page += 1
    ) {
      const read = await dependencies.readPage(coinType, launchId, cursor);
      if (read.status === "unavailable" || read.data.kind !== "answer")
        return UNAVAILABLE;
      const { snapshot, facts } = read.data.value;
      if (
        facts === null ||
        (checkpoint !== null && snapshot.checkpoint !== checkpoint)
      )
        return UNAVAILABLE;
      checkpoint = snapshot.checkpoint;
      const observation = {
        checkpoint,
        observedAtMs: snapshot.timestampMs,
        coinType,
      };
      if (facts.holders.some((holder) => holder.address === wallet)) {
        return { verification: "verified_holder", ...observation };
      }
      if (facts.nextCursor === null)
        return { verification: "not_holder", ...observation };
      cursor = facts.nextCursor;
    }
    return UNAVAILABLE;
  }

  return {
    async prove(launchId, wallet) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let late = false;
      const deadline = new Promise<HolderProof>((resolve) => {
        timer = setTimeout(() => {
          late = true;
          resolve(UNAVAILABLE);
        }, dependencies.deadlineMs);
      });
      try {
        const operation = attempt(launchId, wallet, () => late).catch(
          () => UNAVAILABLE,
        );
        const owned = dependencies.trackWork
          ? dependencies.trackWork(operation)
          : operation;
        return await Promise.race([owned, deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
