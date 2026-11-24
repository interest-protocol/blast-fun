import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import {
  initialActionState,
  reduceAction,
  type ActionEvent,
  type ActionState,
  type ReconciliationOutcome,
  type SignerKind,
  type SignerSummary,
} from "./action-machine.ts";
import { describeError } from "./errors.ts";
import { reconcileTransaction, signAndSubmitOnce } from "./execution.ts";
import { runFreshPreflight, type CompletionExpectation, type LaunchpadActionAdapter, type LaunchpadChain } from "./preflight.ts";
import type { LaunchpadSigner } from "./signer.ts";

/**
 * Where signers come from. `current` must not prompt or initialize anything;
 * only `connect`, called after the user submits and picks a signer, may.
 */
export type SignerSource = Readonly<{
  kinds: readonly SignerKind[];
  current(): LaunchpadSigner | null;
  connect(kind: SignerKind): Promise<LaunchpadSigner>;
}>;

export type ActionController<Input> = Readonly<{
  getState(): ActionState<Input>;
  subscribe(listener: () => void): () => void;
  edit(input: Input): void;
  /** Confirm in the wallet after fresh simulation, or stop at an in-app review by default. */
  submit(options?: Readonly<{ confirmInWallet?: boolean }>): void;
  chooseSigner(kind: SignerKind): void;
  cancel(): void;
  approve(reviewId: string): void;
  recheck(): void;
  acknowledge(): void;
  /** Listens for the read keys to refresh after a transaction completes. */
  onInvalidate(listener: (keys: readonly string[]) => void): () => void;
}>;

export type CaptureConfirmation = (signer: LaunchpadSigner) => ((confirmation: Readonly<{
  digest: string;
  explorerUrl: string | null;
}>) => void) | undefined;

function summary(signer: LaunchpadSigner | null): SignerSummary | null {
  return signer && { kind: signer.kind, address: signer.address, chain: signer.chain };
}

/**
 * Runs one action through the shared machine: connect on action, fresh
 * preflight, review and reconfirmation, one signature per approval, one
 * submission, reconciliation by digest, and read invalidation. Wallet-confirmed
 * submissions sign the freshly simulated bytes without an extra in-app review.
 */
export function createActionController<Input, Fresh>({
  adapter,
  chain,
  signers,
  input,
  newReviewId = () => crypto.randomUUID(),
  onSigned,
  captureConfirmation,
  restart,
}: Readonly<{
  adapter: LaunchpadActionAdapter<Input, Fresh>;
  chain: LaunchpadChain;
  signers: SignerSource;
  input: Input;
  newReviewId?: () => string;
  /**
   * Optional: told the signed transaction's digest and the input it was
   * reviewed for, once per signature, after the wallet returns a valid
   * signature and before the transaction is submitted. It is not awaited and
   * a throw is ignored, so it never delays or changes the submission.
   */
  onSigned?: (signed: Readonly<{ digest: string; input: Input }>) => void;
  /** Captures feedback at signing, so confirmation can notify after a view unsubscribes. */
  captureConfirmation?: CaptureConfirmation;
  /**
   * Optional: the input a new action starts from once an action succeeds, so
   * a finished amount is never left in the box or typed into again. Without it
   * the last input stays. Failures and rejections always keep the input.
   */
  restart?: (input: Input) => Input;
}>): ActionController<Input> {
  let state = initialActionState(input);
  let signer: LaunchpadSigner | null = null;
  let connectedForAttempt: number | null = null;
  let deployment: BlastDeployment | null = null;
  let notifyConfirmation: ReturnType<CaptureConfirmation>;
  // The evidence the last ready review's transaction must show to succeed.
  let completion: CompletionExpectation = adapter.completion;
  const listeners = new Set<() => void>();
  const invalidationListeners = new Set<(keys: readonly string[]) => void>();
  // One entry per started step and attempt; a signature request is never repeated.
  const started = new Set<string>();

  function dispatch(event: ActionEvent<Input>) {
    let next = reduceAction(state, event);
    if (next === state) return;
    if (restart && next.phase === "succeeded" && state.phase !== "succeeded") next = { ...next, input: restart(next.input) };
    state = next;
    for (const listener of listeners) listener();
    run(next);
  }

  function once(step: string, attempt: number): boolean {
    const key = `${step}:${attempt}`;
    if (started.has(key)) return false;
    started.add(key);
    return true;
  }

  async function connect(kind: SignerKind, attempt: number) {
    try {
      signer = await signers.connect(kind);
      connectedForAttempt = attempt + 1;
      dispatch({ type: "signer-connected", attempt, signer: summary(signer)! });
    } catch (error) {
      dispatch({ type: "signer-unavailable", attempt, message: `The signer did not connect: ${describeError(error)}` });
    }
  }

  async function preflight(current: ActionState<Input>) {
    // A wallet connection may resolve before React publishes the bridge's current
    // account. Its return value is valid for this first, unsigned review only.
    if (connectedForAttempt !== current.attempt) signer = signers.current();
    connectedForAttempt = null;
    if (!signer) {
      dispatch({
        type: "preflight-resolved",
        attempt: current.attempt,
        outcome: {
          status: "blocked",
          block: { stage: "signer", code: "signer-unavailable", message: "Connect a wallet, then review again.", details: [] },
        },
      });
      return;
    }
    const result = await runFreshPreflight({ chain, signer, adapter, input: current.input, reviewId: newReviewId() });
    if (result.outcome.status === "ready") {
      deployment = result.deployment;
      completion = result.completion ?? adapter.completion;
    }
    dispatch({ type: "preflight-resolved", attempt: current.attempt, outcome: result.outcome });
  }

  async function sign(current: Extract<ActionState<Input>, { phase: "signing" }>) {
    const { attempt, review } = current;
    signer = signers.current();
    if (!signer || signer.address !== review.signer.address || signer.chain !== review.signer.chain || signer.kind !== review.signer.kind) {
      dispatch({ type: "signature-failed", attempt, message: "The signing wallet changed. Review the transaction again." });
      return;
    }
    if (review.expiresAtMs !== null && review.expiresAtMs !== undefined && review.expiresAtMs <= Date.now()) {
      dispatch({ type: "signature-failed", attempt, message: "The quote expired. Refresh it and review the transaction again. Nothing was signed." });
      return;
    }
    try {
      notifyConfirmation = captureConfirmation?.(signer);
    } catch {
      notifyConfirmation = undefined;
    }
    const result = await signAndSubmitOnce({
      client: chain.client,
      signer,
      review,
      onSigned:
        onSigned &&
        ((digest) => {
          try {
            onSigned({ digest, input: current.input });
          } catch {
            // The hook is optional; the submission goes ahead.
          }
        }),
    });
    switch (result.status) {
      case "rejected":
        return dispatch({ type: "signature-rejected", attempt });
      case "signature-failed":
        return dispatch({ type: "signature-failed", attempt, message: result.message });
      case "submitted":
        return dispatch({ type: "submitted", attempt, digest: result.digest });
      case "unknown":
        return dispatch({ type: "submission-unknown", attempt, digest: result.digest, message: result.message });
    }
  }

  async function reconcile(current: Extract<ActionState<Input>, { phase: "reconciling" }>) {
    // Reconciling always follows a ready preflight, which records the deployment.
    // Should that ever fail, say so rather than leave the action reconciling.
    const outcome: ReconciliationOutcome = deployment
      ? await reconcileTransaction({ client: chain.client, deployment, digest: current.digest, completion })
      : {
          status: "pending",
          reason: "confirmation-pending",
          message: `Blast lost the deployment for transaction ${current.digest}. Check it on Sui before signing again.`,
        };
    const notify = notifyConfirmation;
    if (outcome.status !== "pending") notifyConfirmation = undefined;
    dispatch({ type: "reconciled", attempt: current.attempt, outcome });
    if (outcome.status === "succeeded") {
      try {
        notify?.({ digest: current.digest, explorerUrl: outcome.explorerUrl });
      } catch {
        // Feedback is independent of a confirmed action and its invalidations.
      }
    }
    if (outcome.status === "pending") return;
    const keys = adapter.affectedReads(current.input);
    for (const listener of invalidationListeners) listener(keys);
  }

  function run(current: ActionState<Input>) {
    switch (current.phase) {
      case "connecting":
        if (once("connect", current.attempt)) void connect(current.signerKind, current.attempt);
        return;
      case "preflighting":
        if (once("preflight", current.attempt)) void preflight(current);
        return;
      case "signing":
        if (once("sign", current.attempt)) void sign(current);
        return;
      case "reconciling":
        if (once("reconcile", current.attempt)) void reconcile(current);
        return;
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    edit: (next) => dispatch({ type: "edit", input: next }),
    submit: (options) => dispatch({ type: "submit", signer: summary(signers.current()), confirmInWallet: options?.confirmInWallet }),
    chooseSigner: (kind) => dispatch({ type: "choose-signer", kind }),
    cancel: () => dispatch({ type: "cancel" }),
    approve: (reviewId) => dispatch({ type: "approve", reviewId }),
    recheck: () => dispatch({ type: "recheck" }),
    acknowledge: () => dispatch({ type: "acknowledge" }),
    onInvalidate(listener) {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    },
  };
}
