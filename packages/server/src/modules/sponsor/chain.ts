import { createCreatorChain } from "@blast/server/modules/social/creator-earnings/chain.ts";
import { z } from "zod";
import type { CreatorActionKind } from "@blast/core/modules/social/contracts/creator-earnings.ts";

import type { PresaleObject } from "@interest-protocol/blast-sdk/presale";
import { decodeRoundObject, decodeVaultObject } from "@interest-protocol/blast-sdk/vault";
import {
  TransactionError,
  type ClientWithCoreApi,
  type SuiClientTypes,
} from "@mysten/sui/client";
import {
  normalizeStructTag,
  normalizeSuiAddress,
  parseStructTag,
} from "@mysten/sui/utils";

import type { PresaleRuntimeIdentity } from "@blast/core/modules/presale/deployment/contracts.ts";
import {
  decodeLinearVesting,
  type LinearVestingSchedule,
} from "@blast/core/modules/sponsor/linear-vesting.ts";
import type { SponsorRewardRound } from "@blast/core/modules/sponsor/policy.ts";
import type { SponsorExecutionEffects } from "./pool-execute.ts";

/** Gas a simulation charged, in MIST. */
export type SponsorGasUsed = Readonly<{
  computationCost: bigint;
  storageCost: bigint;
  /** What deleted or rewritten objects refund the gas owner; absent reads as none. */
  storageRebate?: bigint;
}>;

/** Why a simulation did not succeed. */
export type SponsorSimulationFailure =
  | Readonly<{
      kind: "move_abort";
      packageId: string | null;
      module: string | null;
      code: number | null;
    }>
  | Readonly<{ kind: "insufficient_gas" }>
  | Readonly<{ kind: "other"; label: string }>;

/** A fullnode simulation's verdict on the sponsored transaction data. */
export type SponsorSimulation =
  | Readonly<{ status: "success"; gasUsed: SponsorGasUsed }>
  | Readonly<{
      status: "failure";
      failure: SponsorSimulationFailure;
      gasUsed: SponsorGasUsed;
    }>;

/**
 * What the sponsor route reads from the chain. `presaleTypes` and
 * `rewardRounds` answer null or omit an object that is not of this deployment;
 * a node failure rejects (the route answers `service_unavailable`).
 */
export type SponsorChain = Readonly<{
  creatorKind?(
    presaleId: string,
    vaultId: string,
    sender: string,
    kind: CreatorActionKind,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null>;
  /** The sale's `SaleToken` and `Quote` types, or null when `presaleId` is not a presale of this deployment. */
  presaleTypes(
    presaleId: string,
    options?: { signal?: AbortSignal },
  ): Promise<Readonly<{ saleToken: string; quote: string }> | null>;
  /** Each known `holder_rewards::Round` with its vault and that vault's presale; unknown rounds are left out. */
  rewardRounds(
    roundIds: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<SponsorRewardRound[]>;
  /** Each `blast_fun_linear_vesting::Vesting` schedule with its coin and beneficiary (P-13); anything else is left out. */
  vestingSchedules(
    scheduleIds: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<LinearVestingSchedule[]>;
  /** The reference gas price and the current epoch (an address-balance payment expires by the next one). */
  gasContext(options?: {
    signal?: AbortSignal;
  }): Promise<Readonly<{ price: bigint; epoch: bigint }>>;
  /** Simulates full `TransactionData` bytes (sender, gas owner, price and budget set). */
  simulate(
    transactionBytes: Uint8Array,
    options?: { signal?: AbortSignal },
  ): Promise<SponsorSimulation>;
}>;

type SimulationResult = SuiClientTypes.SimulateTransactionResult<{
  effects: true;
}>;

function gasUsedOf(
  effects: SuiClientTypes.TransactionEffects | null | undefined,
): SponsorGasUsed {
  return {
    computationCost: BigInt(effects?.gasUsed.computationCost ?? 0),
    storageCost: BigInt(effects?.gasUsed.storageCost ?? 0),
    storageRebate: BigInt(effects?.gasUsed.storageRebate ?? 0),
  };
}

/** The abort's error code: the clever error's `errorCode`, else a plain abort code. */
function abortCode(abort: SuiClientTypes.MoveAbort): number | null {
  const clever = abort.cleverError?.errorCode;
  if (typeof clever === "number" && Number.isSafeInteger(clever)) return clever;
  const plain = /^[0-9]{1,15}$/.test(abort.abortCode)
    ? Number(abort.abortCode)
    : null;
  return plain !== null && Number.isSafeInteger(plain) ? plain : null;
}

/** Maps a Core API simulation result to the route's verdict. */
export function simulationOutcome(result: SimulationResult): SponsorSimulation {
  const transaction =
    result.$kind === "Transaction"
      ? result.Transaction
      : result.FailedTransaction;
  const effects = transaction?.effects;
  const gasUsed = gasUsedOf(effects);
  const status = effects?.status;
  if (status?.success) return { status: "success", gasUsed };
  const error = status?.error;
  if (error?.$kind === "MoveAbort") {
    const abort = error.MoveAbort;
    return {
      status: "failure",
      gasUsed,
      failure: {
        kind: "move_abort",
        packageId: abort.location?.package
          ? normalizeSuiAddress(abort.location.package)
          : null,
        module: abort.location?.module ?? null,
        code: abortCode(abort),
      },
    };
  }
  if (
    error &&
    /insufficient[\s_]*gas/i.test(`${error.$kind} ${error.message}`)
  ) {
    return {
      status: "failure",
      gasUsed,
      failure: { kind: "insufficient_gas" },
    };
  }
  return {
    status: "failure",
    gasUsed,
    failure: { kind: "other", label: error?.$kind ?? "unknown" },
  };
}

function sharedObject(
  object: SuiClientTypes.Object<{ content: true }> | Error | undefined,
): PresaleObject | null {
  if (!object || object instanceof Error || object.owner.$kind !== "Shared")
    return null;
  return {
    objectId: object.objectId,
    initialSharedVersion: object.owner.Shared.initialSharedVersion,
    type: object.type,
    content: object.content,
  };
}

/**
 * The chain reads over a Core API client (the presale node): the presale's
 * type arguments from its object type, each round's vault through the SDK's
 * own decoders, the reference gas price, and the simulation.
 */
export function createSponsorChain(
  input: Readonly<{
    client: ClientWithCoreApi;
    identity: PresaleRuntimeIdentity;
  }>,
): SponsorChain {
  const { core } = input.client;
  const original = normalizeSuiAddress(
    input.identity.presale.originalPackageId,
  );
  const vaultDeployment = input.identity.presale.vault;
  const packageWitness = `${original}::blast_presale_package::PackageWitness`;
  const objects = async (objectIds: string[], signal?: AbortSignal) =>
    objectIds.length === 0
      ? []
      : (
          await core.getObjects({
            objectIds,
            include: { content: true },
            signal,
          })
        ).objects;
  return Object.freeze({
    async creatorKind(presaleId, vaultId, sender, kind, signal) {
      const action = await createCreatorChain(
        input.client,
        input.identity,
      ).transaction(vaultId, sender, kind, signal);
      return action?.presaleId === presaleId ? action.kindBytes : null;
    },
    async presaleTypes(presaleId, options = {}) {
      const [object] = await objects([presaleId], options.signal);
      const presale = sharedObject(object);
      if (!presale) return null;
      const tag = parseStructTag(presale.type);
      const [saleToken, quote, ...extra] = tag.typeParams;
      if (
        normalizeSuiAddress(tag.address) !== original ||
        tag.module !== "blast_presale" ||
        tag.name !== "Presale"
      )
        return null;
      if (saleToken === undefined || quote === undefined || extra.length > 0)
        return null;
      return {
        saleToken: normalizeStructTag(saleToken),
        quote: normalizeStructTag(quote),
      };
    },
    async rewardRounds(roundIds, options = {}) {
      const rounds = (await objects([...roundIds], options.signal)).flatMap(
        (object) => {
          const shared = sharedObject(object);
          if (!shared) return [];
          try {
            const round = decodeRoundObject(shared, vaultDeployment);
            return [
              {
                roundId: normalizeSuiAddress(round.objectId),
                vaultId: round.vaultId,
                memeType: round.memeType,
                quoteType: round.quoteType,
              },
            ];
          } catch {
            return [];
          }
        },
      );
      const vaults = await objects(
        rounds.map((round) => round.vaultId),
        options.signal,
      );
      return rounds.flatMap((round, index) => {
        const shared = sharedObject(vaults[index]);
        if (!shared) return [];
        try {
          const vault = decodeVaultObject(shared, vaultDeployment);
          if (vault.terms.packageWitness !== packageWitness || vault.memeType !== round.memeType || vault.quoteType !== round.quoteType) return [];
          return [
            { roundId: round.roundId, vaultId: round.vaultId, vaultPresaleId: vault.terms.origin },
          ];
        } catch {
          return [];
        }
      });
    },
    async vestingSchedules(scheduleIds, options = {}) {
      return (await objects([...scheduleIds], options.signal)).flatMap(
        (object) => {
          const schedule =
            object && !(object instanceof Error)
              ? decodeLinearVesting(object)
              : null;
          return schedule ? [schedule] : [];
        },
      );
    },
    async gasContext(options = {}) {
      const { systemState } = await core.getCurrentSystemState({ signal: options.signal });
      if (!z.string().regex(/^[1-9][0-9]*$/).safeParse(systemState.referenceGasPrice).success) throw new Error("The node reported no reference gas price.");
      return { price: BigInt(systemState.referenceGasPrice), epoch: BigInt(systemState.epoch) };
    },
    async simulate(transactionBytes, options = {}) {
      return simulationOutcome(
        await core.simulateTransaction({
          transaction: transactionBytes,
          include: { effects: true },
          signal: options.signal,
        }),
      );
    },
  });
}

/** The execute route's digest lookup on the presale node. */
export type SponsorTransactionLookup = Readonly<{
  /**
   * The executed transaction's effects, or null when the node does not know
   * the digest (yet). Any other node failure rejects; the route then looks again.
   */
  effects(
    digest: string,
    options?: { signal?: AbortSignal },
  ): Promise<SponsorExecutionEffects | null>;
}>;

/** Looks a digest up through a Core API client (the presale node); a checkpoint is not required. */
export function createSponsorTransactionLookup(
  client: ClientWithCoreApi,
): SponsorTransactionLookup {
  return Object.freeze({
    async effects(digest, options = {}) {
      let result: SuiClientTypes.TransactionResult<{ effects: true }>;
      try {
        result = await client.core.getTransaction({
          digest,
          include: { effects: true },
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof TransactionError && error.reason === "notFound")
          return null;
        throw error;
      }
      const effects = (
        result.$kind === "Transaction"
          ? result.Transaction
          : result.FailedTransaction
      )?.effects;
      if (!effects || effects.transactionDigest !== digest) return null;
      const { computationCost, storageCost, storageRebate } = effects.gasUsed;
      return {
        digest,
        status: effects.status.success ? "success" : "failure",
        gasUsed:
          BigInt(computationCost) + BigInt(storageCost) - BigInt(storageRebate),
      };
    },
  });
}
