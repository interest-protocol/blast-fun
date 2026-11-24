import { defineBlastDeployment, launchpadDeployment } from "@interest-protocol/blast-sdk/deployments";
import { decodeRuntimeConfigObject, LaunchpadTransactions, type LaunchState } from "@interest-protocol/blast-sdk/launchpad";
import { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import { createFreshLaunchReader, type LaunchReadChain } from "@blast/server/modules/launchpad-coin/fresh.ts";

type Signal = Readonly<{ signal?: AbortSignal }>;

export type CreatorCapsSimulation = Readonly<{ status: "success" }> | Readonly<{ status: "failure"; reason: string }>;

/** What the creator-caps route reads from, and builds against, the released launchpad deployment. */
export type CreatorCapsChain = Readonly<{
  /** The launch as the node shows it now; null when no launch of this deployment has that ID. */
  launch(launchId: string): Promise<LaunchState | null>;
  /** Applied signer admissions in the launchpad RuntimeConfig. */
  signerPublicKeys(options?: Signal): Promise<readonly string[]>;
  /** `launch::claim_creator_caps`, both caps sent to `claimant`, as transaction kind bytes. */
  kind(input: Readonly<{ launch: LaunchState; claimant: string; attestation: Uint8Array | null }>): Promise<Uint8Array>;
  /** The kind's dry run as `sender`, checks off (a sponsored wallet holds no SUI for gas). */
  simulate(kind: Uint8Array, sender: string, options?: Signal): Promise<CreatorCapsSimulation>;
}>;

export function createCreatorCapsChain(chain: LaunchReadChain): CreatorCapsChain {
  const { core } = chain.client;
  const deployment = launchpadDeployment(defineBlastDeployment(chain.manifest));
  const transactions = new LaunchpadTransactions(deployment);
  const readFresh = createFreshLaunchReader(chain);
  return Object.freeze({
    async launch(launchId) {
      const fresh = await readFresh(launchId);
      if (fresh.status === "unavailable") throw new Error(fresh.reason);
      return fresh.status === "read" ? fresh.launch : null;
    },
    async signerPublicKeys(options = {}) {
      const { object } = await core.getObject({ objectId: deployment.runtimeConfig.objectId, include: { content: true }, signal: options.signal });
      if (object.owner.$kind !== "Shared") throw new TypeError("the runtime config is not a shared object");
      return decodeRuntimeConfigObject(
        {
          objectId: object.objectId,
          initialSharedVersion: object.owner.Shared.initialSharedVersion,
          type: object.type,
          content: object.content,
        },
        deployment.originalPackageId,
      ).creatorClaimSigners;
    },
    kind({ launch, claimant, attestation }) {
      return transactions
        .claimCreatorCaps({
          memeType: launch.memeType,
          quoteType: launch.quoteType,
          launch: { objectId: launch.objectId, initialSharedVersion: launch.initialSharedVersion },
          recipient: claimant,
          accountAttestation: attestation,
        })
        .build({ client: chain.client, onlyTransactionKind: true });
    },
    async simulate(kind, sender, options = {}) {
      const transaction = Transaction.fromKind(kind);
      transaction.setSender(normalizeSuiAddress(sender));
      const result = await core.simulateTransaction({ transaction, include: { effects: true }, checksEnabled: false, signal: options.signal });
      const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
      const status = executed?.effects?.status ?? executed?.status;
      if (status?.success) return { status: "success" };
      const error = status?.error;
      if (error?.$kind === "MoveAbort") {
        const abort = error.MoveAbort;
        return { status: "failure", reason: `${abort.location?.module ?? "unknown"}:${abort.cleverError?.errorCode ?? abort.abortCode}` };
      }
      return { status: "failure", reason: error?.$kind ?? "unknown" };
    },
  });
}
