// The Complete migration flow: the shared action machine for one launch plus
// fresh race reconciliation. A submitted digest never completes it. Only the
// checkpointed transaction's `Migrated` event (this wallet's migration) or a
// fresh read of the launch object showing Migrated (another wallet's or the
// automation's) does. After a failure, the same fresh read says whether the
// launch is still ready, so the action stays open for a retry.

import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { getLaunch, type LaunchLifecycle } from "@interest-protocol/blast-sdk/launchpad";

import type { ActionState, SignerKind, SignerSummary } from "../transaction/action-machine.ts";
import { createActionController, type SignerSource } from "../transaction/controller.ts";
import { describeError } from "../transaction/errors.ts";
import { reconcileTransaction } from "../transaction/execution.ts";
import type { LaunchpadChain } from "../transaction/preflight.ts";
import { migrationAdapter, type MigrationInput } from "./migration-adapter.ts";
import type { MigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";

export type MigrationCompletion = Readonly<{
  /** `you`: this wallet's transaction carried `Migrated`; `another`: the launch was migrated by someone else. */
  by: "you" | "another";
  digest: string | null;
  explorerUrl: string | null;
}>;

/** Whether the launch has migrated, from fresh chain evidence only. */
export type Settlement =
  | Readonly<{ status: "open" }>
  | Readonly<{ status: "checking" }>
  | Readonly<{ status: "still-ready"; message: string }>
  | Readonly<{ status: "unverified"; message: string }>
  | (Readonly<{ status: "completed" }> & MigrationCompletion);

export type MigrationFlowState = Readonly<{ action: ActionState<MigrationInput>; settlement: Settlement }>;

/** A venue as diagnostics name it: a closed list. */
export type DiagnosticVenue = MigratorVenue | "other";

/**
 * Manual-fallback diagnostics, every property from a closed list. `used`: a
 * signed migration was submitted through the public action. `completed`:
 * verified `Migrated` evidence, by this wallet (`self`) or another (`other`).
 */
export type MigrationDiagnostic =
  | Readonly<{ event: "migration_manual_used"; venue: DiagnosticVenue }>
  | Readonly<{ event: "migration_manual_completed"; venue: DiagnosticVenue; by: "self" | "other" }>;

export type MigrationFlow = Readonly<{
  getState(): MigrationFlowState;
  subscribe(listener: () => void): () => void;
  submit(): void;
  chooseSigner(kind: SignerKind): void;
  cancel(): void;
  approve(reviewId: string): void;
  recheck(): void;
  /** Leaves a finished state. Ignored while this flow's submitted transaction is unresolved. */
  acknowledge(): void;
  /** Reads the launch again after a check could not answer. */
  checkAgain(): void;
  /** Runs once, when the migration is verified complete. */
  onCompleted(listener: (completion: MigrationCompletion) => void): () => void;
}>;

const STILL_READY =
  "Sui still shows this launch as migration ready, so it has not migrated. Nothing else was submitted; review the migration again to retry.";
const UNVERIFIED = "Blast could not read the launch from Sui to tell whether it migrated. Nothing else was submitted.";

/** How long each own-digest lookup may take before a foreign completion is concluded. */
const OWN_DIGEST_TIMEOUT_MS = 5_000;

/** Reads the launch object's lifecycle now, through the SDK. */
export async function readLaunchLifecycle(chain: LaunchpadChain, launchId: string): Promise<LaunchLifecycle> {
  const deployment = defineBlastDeployment(chain.manifest);
  const launch = await getLaunch(chain.client, launchId, deployment.packages.launchpad.originalPackageId);
  return launch.lifecycle;
}

function diagnosticVenue(venue: string): DiagnosticVenue {
  return venue === "cetus" || venue === "bluefin" ? venue : "other";
}

/** Whether this action state needs a fresh read of the launch to know where the migration stands. */
function needsCheck(state: ActionState<MigrationInput>): boolean {
  if (state.phase === "failed") return true;
  return state.phase === "blocked" && (state.block.code === "stale-lifecycle" || state.block.code === "simulation-failed");
}

export function createMigrationFlow({
  chain,
  signers,
  launchId,
  venue,
  report = () => {},
  captureConfirmation,
  newReviewId,
  readLifecycle = readLaunchLifecycle,
}: Readonly<{
  chain: LaunchpadChain;
  signers: SignerSource;
  launchId: string;
  /** The launch's recorded venue, for diagnostics only; the action reads its own route. */
  venue: string;
  report?: (diagnostic: MigrationDiagnostic) => void;
  captureConfirmation?: (signer: SignerSummary) => (completion: MigrationCompletion) => void;
  newReviewId?: () => string;
  readLifecycle?: (chain: LaunchpadChain, launchId: string) => Promise<LaunchLifecycle>;
}>): MigrationFlow {
  const action = createActionController({ adapter: migrationAdapter, chain, signers, input: { launchId }, newReviewId });
  const diagnosticsVenue = diagnosticVenue(venue);
  const listeners = new Set<() => void>();
  const completedListeners = new Set<(completion: MigrationCompletion) => void>();
  let settlement: Settlement = { status: "open" };
  let state: MigrationFlowState = { action: action.getState(), settlement };
  let previous = action.getState();
  let notifyConfirmation: ((completion: MigrationCompletion) => void) | undefined;
  // Identifies the action state a check belongs to; a check for an older one is dropped.
  let checkToken = 0;
  // Digests this flow submitted whose outcome Sui has not settled (neither succeeded nor failed).
  const unresolved = new Set<string>();

  /** While a submitted transaction is unresolved, nothing may leave it or start another attempt. */
  const holding = () => unresolved.size > 0;

  /** This flow's own unresolved transaction that carries `Migrated`, if one landed. */
  async function ownMigration(): Promise<MigrationCompletion | null> {
    const deployment = defineBlastDeployment(chain.manifest);
    for (const digest of unresolved) {
      const outcome = await reconcileTransaction({
        client: chain.client,
        deployment,
        digest,
        completion: migrationAdapter.completion,
        timeoutMs: OWN_DIGEST_TIMEOUT_MS,
      });
      if (outcome.status === "succeeded") return { by: "you", digest, explorerUrl: outcome.explorerUrl };
    }
    return null;
  }

  function emit(diagnostic: MigrationDiagnostic) {
    try {
      report(diagnostic);
    } catch {
      // Diagnostics are optional; the migration carries on.
    }
  }

  function publish() {
    state = { action: action.getState(), settlement };
    for (const listener of listeners) listener();
  }

  // A function, so a check that awaited reads the settlement as it is now.
  const isCompleted = () => settlement.status === "completed";

  function complete(completion: MigrationCompletion) {
    if (settlement.status === "completed") return;
    settlement = { status: "completed", ...completion };
    publish();
    emit({ event: "migration_manual_completed", venue: diagnosticsVenue, by: completion.by === "you" ? "self" : "other" });
    if (completion.by === "you") {
      try {
        notifyConfirmation?.(completion);
      } catch {
        // Feedback is independent of settlement.
      }
    }
    for (const listener of completedListeners) listener(completion);
  }

  async function check() {
    const token = (checkToken += 1);
    settlement = { status: "checking" };
    publish();
    let lifecycle: LaunchLifecycle | null = null;
    let failure = "";
    try {
      lifecycle = await readLifecycle(chain, launchId);
    } catch (error) {
      failure = describeError(error);
    }
    // A completion verified while this read was in flight stands.
    if (isCompleted()) return;
    if (lifecycle === "Migrated") {
      // Never credit another wallet with a migration this wallet's own unresolved transaction made.
      const own = await ownMigration().catch(() => null);
      return complete(own ?? { by: "another", digest: null, explorerUrl: null });
    }
    if (token !== checkToken) return;
    settlement =
      lifecycle === null
        ? { status: "unverified", message: `${UNVERIFIED} (${failure})` }
        : lifecycle === "MigrationReady"
          ? { status: "still-ready", message: STILL_READY }
          : { status: "open" };
    publish();
  }

  action.subscribe(() => {
    const next = action.getState();
    const before = previous;
    previous = next;
    if (next.phase === "signing" && before.phase !== "signing") {
      try {
        notifyConfirmation = captureConfirmation?.(next.review.signer);
      } catch {
        notifyConfirmation = undefined;
      }
    }
    if (before.phase === "signing" && (next.phase === "reconciling" || next.phase === "ambiguous")) {
      emit({ event: "migration_manual_used", venue: diagnosticsVenue });
    }
    // A checkpointed transaction without `Migrated` is final: it can no longer migrate the launch.
    if (next.phase === "ambiguous" && next.reason === "evidence-missing") unresolved.delete(next.digest);
    else if (next.phase === "reconciling" || next.phase === "ambiguous") unresolved.add(next.digest);
    if ((next.phase === "succeeded" || next.phase === "failed") && next.digest) unresolved.delete(next.digest);
    if (settlement.status === "completed") return publish();
    if (next.phase === "succeeded") return complete({ by: "you", digest: next.digest, explorerUrl: next.explorerUrl });
    if (needsCheck(next)) {
      publish();
      void check();
      return;
    }
    checkToken += 1;
    settlement = { status: "open" };
    publish();
  });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    submit: () => void (holding() || action.submit()),
    chooseSigner: (kind) => void (holding() || action.chooseSigner(kind)),
    cancel: action.cancel,
    approve: (reviewId) => void (holding() || action.approve(reviewId)),
    recheck: action.recheck,
    acknowledge: () => void (holding() || action.acknowledge()),
    checkAgain() {
      if (settlement.status === "unverified" || settlement.status === "still-ready") void check();
    },
    onCompleted(listener) {
      completedListeners.add(listener);
      return () => completedListeners.delete(listener);
    },
  };
}
