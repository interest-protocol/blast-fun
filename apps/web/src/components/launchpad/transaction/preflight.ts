import { shortAddress } from "@blast/core/lib/format.ts";
import { safeErrorCode, diagnosticMessage } from "#web/lib/errors.ts";
import {
  defineBlastDeployment,
  evaluateProtocolAccess,
  observeDeploymentRuntime,
  type BlastDeployment,
  type BlastDeploymentInput,
  type DeploymentEnvironment,
  type ProtocolAccess,
} from "@interest-protocol/blast-sdk/deployments";
import type { LaunchpadEventKind } from "@interest-protocol/blast-sdk/launchpad";
import type { MigratorsEventKind } from "@interest-protocol/blast-sdk/migrators";
import { SimulationError, type ClientWithCoreApi, type SuiClientTypes } from "@mysten/sui/client";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import type {
  MaterialFact,
  PreflightBlock,
  PreflightBlockCode,
  PreflightOutcome,
  PreflightStage,
} from "./action-machine.ts";
import { abortIn, contractRejection } from "../launch/advanced/contract-errors.ts";
import { describeError } from "./errors.ts";
import type { LaunchpadSigner } from "./signer.ts";

/** The deployment identity and node every fresh read, simulation, and submission uses. */
export type LaunchpadChain = Readonly<{
  client: ClientWithCoreApi;
  manifest: BlastDeploymentInput;
  mode: DeploymentEnvironment;
}>;

/** The configured package whose original ID a required object's type must carry. */
export type PackageLineage = "launchpad" | "vault" | "migrators" | "blastSui" | "cetusClmm" | "bluefinSpot";

/** One object the action needs, as the node reported it just now; `type` is null when it is absent. */
export type RequiredObject = Readonly<{
  role: string;
  objectId: string;
  type: string | null;
  lineage: PackageLineage;
}>;

export type FreshRead<Fresh> = Readonly<{ objects: readonly RequiredObject[]; value: Fresh | null }>;

export type Eligibility =
  | Readonly<{ eligible: true }>
  | Readonly<{
      eligible: false;
      code: Extract<PreflightBlockCode, "stale-lifecycle" | "stale-route" | "insufficient-balance" | "ineligible">;
      message: string;
      /** The input field the refusal concerns, carried onto the block. */
      field?: string;
    }>;

/** A deployment the node confirmed now, with core signing enabled. */
export type EnabledAccess = Extract<ProtocolAccess, { signing: "enabled" }>;

export type ActionContext<Input> = Readonly<{
  client: ClientWithCoreApi;
  deployment: BlastDeployment;
  /** The confirmed access: venue actions also need `access.venues[venue].available`. */
  access: EnabledAccess;
  signer: LaunchpadSigner;
  input: Input;
}>;

/** The simulated transaction, with its events, as `checkSimulation` receives it. */
export type SimulatedTransaction = Pick<SuiClientTypes.Transaction<{ events: true }>, "digest" | "status" | "events">;

/** The configured-package evidence a completed transaction must show before success. */
export type CompletionExpectation =
  | Readonly<{ kind: "event"; source: "launchpad"; event: LaunchpadEventKind }>
  | Readonly<{ kind: "event"; source: "migrators"; event: MigratorsEventKind }>
  | Readonly<{ kind: "created-object"; lineage: PackageLineage; module: string; name: string }>
  /** The completed transaction must pass `check`, such as an SDK reconciliation against the signed quote. */
  | Readonly<{ kind: "check"; check(transaction: SimulatedTransaction): boolean }>;

/**
 * What each financial vertical supplies. Every step works from fresh chain
 * state; indexed dashboard data never decides eligibility or builds a
 * transaction.
 */
export type LaunchpadActionAdapter<Input, Fresh> = Readonly<{
  action: string;
  /** Reads the required objects, balances, and route from the node. */
  readFresh(context: ActionContext<Input>): Promise<FreshRead<Fresh>>;
  eligibility(fresh: Fresh, context: ActionContext<Input>): Eligibility;
  /** The SDK preview of the action over fresh state, as reviewable facts. */
  preview(fresh: Fresh, context: ActionContext<Input>): readonly MaterialFact[];
  /** The SDK-built transaction. The preflight sets its sender to the signer. */
  build(fresh: Fresh, context: ActionContext<Input>): Transaction;
  /** Optional: prepares exact sponsored bytes before simulation. */
  prepare?(transaction: Transaction, fresh: Fresh, context: ActionContext<Input>): Promise<Readonly<{ transaction: Transaction; reservationId?: string; expiresAtMs?: number }>>;
  /** Optional: refuses a simulation that succeeded but is not the reviewed action (it throws with the reason). */
  checkSimulation?(simulated: SimulatedTransaction, fresh: Fresh, context: ActionContext<Input>): void;
  /** Optional: when the reviewed quote stops being signable, in ms since the Unix epoch. */
  expiresAtMs?(fresh: Fresh): number | undefined;
  completion: CompletionExpectation;
  /** Optional: the completion evidence for this review's transaction; `completion` otherwise. */
  completionFor?(fresh: Fresh, context: ActionContext<Input>): CompletionExpectation;
  /** Read keys to refresh once the transaction has completed. */
  affectedReads(input: Input): readonly string[];
}>;

export type PreflightResult = Readonly<{
  outcome: PreflightOutcome;
  deployment: BlastDeployment | null;
  /** The completion evidence a ready review's transaction must show. */
  completion: CompletionExpectation | null;
}>;

class Blocked extends Error {
  readonly block: PreflightBlock;

  constructor(stage: PreflightStage, code: PreflightBlockCode, message: string, details: readonly string[] = [], field?: string) {
    message = diagnosticMessage(message, { code });
    super(message);
    this.block = field === undefined ? { stage, code, message, details } : { stage, code, message, details, field };
  }
}

async function guarded<Value>(
  stage: PreflightStage,
  code: PreflightBlockCode,
  message: string,
  work: () => Value | Promise<Value>,
): Promise<Value> {
  try {
    return await work();
  } catch (error) {
    throw new Blocked(stage, code, message, [describeError(error)]);
  }
}

function networkName(chain: string | null): string {
  return chain?.startsWith("sui:") ? `Sui ${chain.slice(4)}` : "an unsupported network";
}

async function acceptedDeployment(chain: LaunchpadChain) {
  const deployment = await guarded(
    "deployment",
    "deployment-rejected",
    "Signing is unavailable because the app's Blast deployment is invalid.",
    () => defineBlastDeployment(chain.manifest),
  );
  const runtime = await guarded(
    "deployment",
    "fresh-read-unavailable",
    "Blast could not confirm its deployment on Sui right now. Nothing was signed. Try again shortly.",
    () => observeDeploymentRuntime(chain.client, deployment),
  );
  const access = evaluateProtocolAccess({ manifest: deployment, mode: chain.mode, runtime });
  if (access.signing === "disabled") {
    throw new Blocked(
      "deployment",
      "deployment-rejected",
      "Signing is unavailable because this app is not connected to a verified Blast deployment.",
      access.reasons.map((reason) => safeErrorCode(reason.code, "deployment-rejected")),
    );
  }
  return access;
}

function checkObjects(deployment: BlastDeployment, objects: readonly RequiredObject[]) {
  const network = `Sui ${deployment.network}`;
  for (const object of objects) {
    if (object.type === null) {
      throw new Blocked("objects", "object-unavailable", `${object.role} does not exist on ${network}.`, [object.objectId]);
    }
    const original = deployment.packages[object.lineage]?.originalPackageId;
    let owner: string | null = null;
    try {
      owner = parseStructTag(object.type).address;
    } catch {
      owner = null;
    }
    if (!original || owner !== normalizeSuiAddress(original)) {
      throw new Blocked("objects", "foreign-lineage", `${object.role} does not belong to this Blast deployment.`, [
        object.type,
      ]);
    }
  }
}

function isGasBalanceError(error: unknown): boolean {
  return error instanceof Error && (
    error.message.startsWith("Unable to perform gas selection due to insufficient SUI balance") ||
    error.message === "No valid gas coins found for the transaction."
  );
}

async function buildForSimulation(
  client: ClientWithCoreApi,
  transaction: Transaction,
  sender: string,
  deployment: BlastDeployment,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    transaction.setSender(sender);
    bytes = await transaction.build({ client });
  } catch (error) {
    if (isGasBalanceError(error)) {
      throw new Blocked("simulation", "insufficient-balance", "Your wallet needs SUI for the network fee. Add SUI to this wallet, then review again. Nothing was signed.");
    }
    // Building without a gas budget simulates the transaction to estimate one:
    // a transaction that fails there is Sui's refusal, not an outage.
    if (error instanceof SimulationError && error.executionError) {
      const rejection = contractRejection(error.executionError.message, deployment);
      const bluefin = abortIn(error.executionError.message, deployment.packages.bluefinSpot)?.code === 1010;
      throw new Blocked("simulation", "simulation-failed", rejection?.message ?? (bluefin ? "Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept. Nothing was signed." : "Sui rejected this transaction in simulation: the network rejected it. Nothing was signed."), [], rejection?.field);
    }
    throw new Blocked("simulation", "simulation-unavailable", "Blast could not prepare this transaction for simulation. Nothing was signed. Try again shortly.", [
      describeError(error),
    ]);
  }
  return bytes;
}

async function simulate(
  client: ClientWithCoreApi,
  transaction: Transaction,
  sender: string,
  deployment: BlastDeployment,
): Promise<Readonly<{ bytes: Uint8Array; simulated: SimulatedTransaction }>> {
  const bytes = await buildForSimulation(client, transaction, sender, deployment);
  const result = await guarded(
    "simulation",
    "simulation-unavailable",
    "Sui could not simulate this transaction right now. Nothing was signed. Try again shortly.",
    () => client.core.simulateTransaction({ transaction: bytes, include: { effects: true, events: true } }),
  );
  const executed = result.Transaction ?? result.FailedTransaction;
  if (result.$kind !== "Transaction" || !executed.status.success) {
    const rejection = executed.status.success ? null : contractRejection(executed.status.error.message, deployment);
    const bluefin = !executed.status.success && abortIn(executed.status.error.message, deployment.packages.bluefinSpot)?.code === 1010;
    const reason = executed.status.success ? "the transaction failed" : "the network rejected it.";
    throw new Blocked(
      "simulation",
      "simulation-failed",
      rejection?.message ?? (bluefin ? "Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept. Nothing was signed." : `Sui rejected this transaction in simulation: ${reason} Nothing was signed.`),
      [],
      rejection?.field,
    );
  }
  return { bytes, simulated: { digest: executed.digest, status: executed.status, events: executed.events ?? [] } };
}

/**
 * Resolves, in order and each on its own, the deployment, the signer's
 * network, the required objects and eligibility, the SDK preview, and an exact
 * simulation. Any failure blocks the signature; nothing here falls back to
 * indexed or cached data.
 */
export async function runFreshPreflight<Input, Fresh>({
  chain,
  signer,
  adapter,
  input,
  reviewId,
}: Readonly<{
  chain: LaunchpadChain;
  signer: LaunchpadSigner;
  adapter: LaunchpadActionAdapter<Input, Fresh>;
  input: Input;
  reviewId: string;
}>): Promise<PreflightResult> {
  let deployment: BlastDeployment | null = null;
  try {
    const access = await acceptedDeployment(chain);
    deployment = access.deployment;
    const expectedChain = `sui:${deployment.network}`;
    if (signer.chain !== expectedChain) {
      throw new Blocked(
        "signer",
        "wrong-network",
        `${signer.label} is set to ${networkName(signer.chain)}. Switch it to Sui ${deployment.network}, then review again.`,
      );
    }
    const context: ActionContext<Input> = { client: chain.client, deployment, access, signer, input };
    const fresh = await guarded(
      "objects",
      "fresh-read-unavailable",
      "Blast could not read the current on-chain state for this action. Nothing was signed. Try again shortly.",
      () => adapter.readFresh(context),
    );
    checkObjects(deployment, fresh.objects);
    const value = fresh.value;
    if (value === null) {
      throw new Blocked("objects", "object-unavailable", `A required object is missing on Sui ${deployment.network}.`);
    }
    const eligibility = await guarded(
      "objects",
      "ineligible",
      "Blast could not check this action against the current on-chain state. Nothing was signed.",
      () => adapter.eligibility(value, context),
    );
    if (!eligibility.eligible) throw new Blocked("objects", eligibility.code, eligibility.message, [], eligibility.field);
    const preview = await guarded(
      "preview",
      "preview-unavailable",
      "Blast could not preview this action from the current on-chain state. Change the amount or try again.",
      () => adapter.preview(value, context),
    );
    const transaction = await guarded(
      "simulation",
      "simulation-unavailable",
      "Blast could not build this transaction. Nothing was signed. Try again shortly.",
      () => adapter.build(value, context),
    );
    const prepared: { transaction: Transaction; reservationId?: string; expiresAtMs?: number } = await guarded("simulation", "simulation-unavailable", "Blast could not prepare gas sponsorship. Nothing was signed. Try again shortly.",
      () => adapter.prepare?.(transaction, value, context) ?? { transaction });
    const { bytes: transactionBytes, simulated } = await simulate(chain.client, prepared.transaction, signer.address, deployment);
    if (adapter.checkSimulation) {
      const check = adapter.checkSimulation;
      await guarded(
        "simulation",
        "simulation-failed",
        "Sui's simulation of this transaction does not match the review. Nothing was signed.",
        () => check(simulated, value, context),
      );
    }
    const expiry = Math.min(adapter.expiresAtMs?.(value) ?? Infinity, prepared.expiresAtMs ?? Infinity);
    const facts: MaterialFact[] = [
      { key: "network", label: "Network", value: `Sui ${deployment.network}` },
      { key: "signer", label: "Signing wallet", value: `${signer.label} ${shortAddress(signer.address)}` },
      { key: "deployment", label: "Blast deployment", value: access.fingerprint.slice(0, 12) },
      ...preview,
    ];
    return {
      deployment,
      completion: adapter.completionFor?.(value, context) ?? adapter.completion,
      outcome: {
        status: "ready",
        review: {
          id: reviewId,
          facts,
          signer: { kind: signer.kind, address: signer.address, chain: signer.chain },
          deploymentFingerprint: access.fingerprint,
          transactionBytes,
          ...(prepared.reservationId ? { sponsorReservationId: prepared.reservationId } : {}),
          expiresAtMs: Number.isFinite(expiry) ? expiry : null,
        },
      },
    };
  } catch (error) {
    // Fail closed: an unexpected error blocks the signature like any other.
    const block =
      error instanceof Blocked
        ? error.block
        : new Blocked("objects", "ineligible", "Blast could not complete its checks. Nothing was signed.", [
            describeError(error),
          ]).block;
    return { deployment, completion: null, outcome: { status: "blocked", block } };
  }
}
