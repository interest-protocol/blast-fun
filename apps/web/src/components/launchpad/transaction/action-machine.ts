// The shared state machine for every launchpad financial action. It is pure:
// the controller performs reads, signing, and submission and reports results
// back as events. Results that arrive for an earlier attempt are ignored, so a
// late preflight or signature can never act on a newer review.

export type SignerKind = "privy" | "wallet";

/** What the machine records about the signer a review was prepared for. */
export type SignerSummary = Readonly<{
  kind: SignerKind;
  address: string;
  /** The Sui chain the signer will sign for, such as `sui:mainnet`; null when it names none. */
  chain: string | null;
}>;

/** One fact the user approves. A changed value requires another confirmation. */
export type MaterialFact = Readonly<{ key: string; label: string; value: string }>;

export type FactChange = Readonly<{
  key: string;
  label: string;
  before: string | null;
  after: string | null;
}>;

/** A review built from fresh chain reads, an SDK preview, and an exact simulation. */
export type FreshReview = Readonly<{
  id: string;
  facts: readonly MaterialFact[];
  signer: SignerSummary;
  deploymentFingerprint: string;
  /** The exact transaction bytes that were simulated and that the signer is asked to sign. */
  transactionBytes: Uint8Array;
  sponsorReservationId?: string;
  /** When the reviewed quote stops being signable (ms since the Unix epoch); null when it does not expire. */
  expiresAtMs?: number | null;
}>;

export type PreflightStage = "deployment" | "signer" | "objects" | "preview" | "simulation";

export type PreflightBlockCode =
  | "deployment-rejected"
  | "signer-unavailable"
  | "wrong-network"
  | "fresh-read-unavailable"
  | "object-unavailable"
  | "foreign-lineage"
  | "stale-lifecycle"
  | "stale-route"
  | "insufficient-balance"
  | "ineligible"
  | "preview-unavailable"
  | "simulation-unavailable"
  | "simulation-failed";

/** Why a fresh preflight refused to offer a signature, with recovery guidance. */
export type PreflightBlock = Readonly<{
  stage: PreflightStage;
  code: PreflightBlockCode;
  message: string;
  details: readonly string[];
  /** The input field the block concerns, when the adapter names one. */
  field?: string;
}>;

export type PreflightOutcome =
  | Readonly<{ status: "ready"; review: FreshReview }>
  | Readonly<{ status: "blocked"; block: PreflightBlock }>;

export type AmbiguityReason = "submission-unknown" | "confirmation-pending" | "evidence-missing";

export type ReconciliationOutcome =
  | Readonly<{ status: "succeeded"; explorerUrl: string | null; checkpoint: number }>
  | Readonly<{ status: "failed"; explorerUrl: string | null; message: string }>
  | Readonly<{ status: "pending"; reason: Exclude<AmbiguityReason, "submission-unknown">; message: string }>;

export type ActionNotice = Readonly<{ tone: "info" | "caution"; message: string }>;

type Common<Input> = Readonly<{
  input: Input;
  /** Increases whenever asynchronous work starts; results for other attempts are ignored. */
  attempt: number;
}>;

export type ActionState<Input> = Common<Input> &
  (
    | Readonly<{ phase: "editing"; notice: ActionNotice | null }>
    | Readonly<{ phase: "choosing-signer"; confirmInWallet?: boolean }>
    | Readonly<{ phase: "connecting"; signerKind: SignerKind; confirmInWallet?: boolean }>
    | Readonly<{ phase: "preflighting"; purpose: "review" }>
    | Readonly<{ phase: "preflighting"; purpose: "submit" }>
    | Readonly<{ phase: "preflighting"; purpose: "approval"; review: FreshReview }>
    | Readonly<{ phase: "blocked"; block: PreflightBlock }>
    | Readonly<{ phase: "review"; review: FreshReview; changes: readonly FactChange[] }>
    | Readonly<{ phase: "signing"; review: FreshReview }>
    | Readonly<{ phase: "rejected"; message: string }>
    | Readonly<{ phase: "reconciling"; review: FreshReview; digest: string }>
    | Readonly<{ phase: "succeeded"; review: FreshReview; digest: string; explorerUrl: string | null }>
    | Readonly<{
        phase: "failed";
        stage: "signature" | "execution";
        message: string;
        digest: string | null;
        explorerUrl: string | null;
      }>
    | Readonly<{
        phase: "ambiguous";
        review: FreshReview;
        digest: string;
        reason: AmbiguityReason;
        message: string;
      }>
  );

export type ActionPhase = ActionState<unknown>["phase"];

export type ActionEvent<Input> =
  | Readonly<{ type: "edit"; input: Input }>
  | Readonly<{ type: "submit"; signer: SignerSummary | null; confirmInWallet?: boolean }>
  | Readonly<{ type: "choose-signer"; kind: SignerKind }>
  | Readonly<{ type: "signer-connected"; attempt: number; signer: SignerSummary }>
  | Readonly<{ type: "signer-unavailable"; attempt: number; message: string }>
  | Readonly<{ type: "preflight-resolved"; attempt: number; outcome: PreflightOutcome }>
  | Readonly<{ type: "cancel" }>
  | Readonly<{ type: "approve"; reviewId: string }>
  | Readonly<{ type: "signature-rejected"; attempt: number }>
  | Readonly<{ type: "signature-failed"; attempt: number; message: string }>
  | Readonly<{ type: "submitted"; attempt: number; digest: string }>
  | Readonly<{ type: "submission-unknown"; attempt: number; digest: string; message: string }>
  | Readonly<{ type: "reconciled"; attempt: number; outcome: ReconciliationOutcome }>
  | Readonly<{ type: "recheck" }>
  | Readonly<{ type: "acknowledge" }>;

export const REJECTED_MESSAGE =
  "You declined the signature request. Nothing was submitted, and your entry is unchanged.";

const EDITABLE: ReadonlySet<ActionPhase> = new Set([
  "editing",
  "choosing-signer",
  "blocked",
  "review",
  "rejected",
  "failed",
  "succeeded",
]);

const SUBMITTABLE: ReadonlySet<ActionPhase> = new Set([
  "editing",
  "blocked",
  "rejected",
  "failed",
  "succeeded",
]);

const CANCELLABLE: ReadonlySet<ActionPhase> = new Set([
  "choosing-signer",
  "connecting",
  "blocked",
  "review",
]);

export function initialActionState<Input>(input: Input): ActionState<Input> {
  return { phase: "editing", input, attempt: 0, notice: null };
}

/** Compares two reviews' material facts by key. */
export function diffMaterialFacts(
  before: readonly MaterialFact[],
  after: readonly MaterialFact[],
): FactChange[] {
  const previous = new Map(before.map((fact) => [fact.key, fact]));
  const next = new Map(after.map((fact) => [fact.key, fact]));
  const changes: FactChange[] = [];
  for (const fact of after) {
    const old = previous.get(fact.key);
    if (old?.value !== fact.value) {
      changes.push({ key: fact.key, label: fact.label, before: old?.value ?? null, after: fact.value });
    }
  }
  for (const fact of before) {
    if (!next.has(fact.key)) {
      changes.push({ key: fact.key, label: fact.label, before: fact.value, after: null });
    }
  }
  return changes;
}

function editing<Input>(state: ActionState<Input>, notice: ActionNotice | null, input = state.input): ActionState<Input> {
  return { phase: "editing", input, attempt: state.attempt, notice };
}

function preflightResolved<Input>(
  state: ActionState<Input>,
  outcome: PreflightOutcome,
): ActionState<Input> {
  if (state.phase !== "preflighting") return state;
  const { input, attempt } = state;
  if (outcome.status === "blocked") return { phase: "blocked", input, attempt, block: outcome.block };
  if (state.purpose === "submit") return { phase: "signing", input, attempt, review: outcome.review };
  if (state.purpose === "review") {
    return { phase: "review", input, attempt, review: outcome.review, changes: [] };
  }
  const changes = diffMaterialFacts(state.review.facts, outcome.review.facts);
  return changes.length > 0
    ? { phase: "review", input, attempt, review: outcome.review, changes }
    : { phase: "signing", input, attempt, review: outcome.review };
}

function reconciled<Input>(state: ActionState<Input>, outcome: ReconciliationOutcome): ActionState<Input> {
  if (state.phase !== "reconciling") return state;
  const { input, attempt, review, digest } = state;
  switch (outcome.status) {
    case "succeeded":
      return { phase: "succeeded", input, attempt, review, digest, explorerUrl: outcome.explorerUrl };
    case "failed":
      return {
        phase: "failed",
        input,
        attempt,
        stage: "execution",
        message: outcome.message,
        digest,
        explorerUrl: outcome.explorerUrl,
      };
    case "pending":
      return { phase: "ambiguous", input, attempt, review, digest, reason: outcome.reason, message: outcome.message };
  }
}

function isCurrent<Input>(state: ActionState<Input>, event: Readonly<{ attempt: number }>) {
  return state.attempt === event.attempt;
}

export function reduceAction<Input>(state: ActionState<Input>, event: ActionEvent<Input>): ActionState<Input> {
  const { input, attempt } = state;
  switch (event.type) {
    case "edit":
      return EDITABLE.has(state.phase) ? editing(state, null, event.input) : state;
    case "submit":
    case "choose-signer":
      return reviewRequested(state, event);
    case "signer-connected":
    case "signer-unavailable":
      return signerConnectionEvent(state, event);
    case "preflight-resolved":
      return isCurrent(state, event) ? preflightResolved(state, event.outcome) : state;
    case "cancel":
      return CANCELLABLE.has(state.phase) ? editing({ ...state, attempt: attempt + 1 }, null) : state;
    case "approve":
      return state.phase === "review" && state.review.id === event.reviewId
        ? { phase: "preflighting", purpose: "approval", input, attempt: attempt + 1, review: state.review }
        : state;
    case "signature-rejected":
    case "signature-failed":
    case "submitted":
    case "submission-unknown":
      return signatureEvent(state, event);
    case "reconciled":
      return isCurrent(state, event) ? reconciled(state, event.outcome) : state;
    case "recheck":
      return state.phase === "ambiguous"
        ? { phase: "reconciling", input, attempt: attempt + 1, review: state.review, digest: state.digest }
        : state;
    case "acknowledge":
      return acknowledge(state);
  }
}

function reviewRequested<Input>(
  state: ActionState<Input>,
  event: Extract<ActionEvent<Input>, { type: "submit" | "choose-signer" }>,
): ActionState<Input> {
  const { input, attempt } = state;
  if (event.type === "choose-signer") {
    return state.phase === "choosing-signer"
      ? { phase: "connecting", input, attempt: attempt + 1, signerKind: event.kind, ...(state.confirmInWallet ? { confirmInWallet: true } : {}) }
      : state;
  }
  if (!SUBMITTABLE.has(state.phase)) return state;
  return event.signer
    ? { phase: "preflighting", purpose: event.confirmInWallet ? "submit" : "review", input, attempt: attempt + 1 }
    : { phase: "choosing-signer", input, attempt, ...(event.confirmInWallet ? { confirmInWallet: true } : {}) };
}

function signerConnectionEvent<Input>(
  state: ActionState<Input>,
  event: Extract<ActionEvent<Input>, { type: "signer-connected" | "signer-unavailable" }>,
): ActionState<Input> {
  if (state.phase !== "connecting" || !isCurrent(state, event)) return state;
  return event.type === "signer-connected"
    ? { phase: "preflighting", purpose: state.confirmInWallet ? "submit" : "review", input: state.input, attempt: state.attempt + 1 }
    : editing(state, { tone: "caution", message: event.message });
}

function signatureEvent<Input>(
  state: ActionState<Input>,
  event: Extract<ActionEvent<Input>, { type: "signature-rejected" | "signature-failed" | "submitted" | "submission-unknown" }>,
): ActionState<Input> {
  if (state.phase !== "signing" || !isCurrent(state, event)) return state;
  const { input, attempt, review } = state;
  switch (event.type) {
    case "signature-rejected": return { phase: "rejected", input, attempt, message: REJECTED_MESSAGE };
    case "signature-failed": return { phase: "failed", input, attempt, stage: "signature", message: event.message, digest: null, explorerUrl: null };
    case "submitted": return { phase: "reconciling", input, attempt, review, digest: event.digest };
    case "submission-unknown": return { phase: "ambiguous", input, attempt, review, digest: event.digest, reason: "submission-unknown", message: event.message };
  }
}

function acknowledge<Input>(state: ActionState<Input>): ActionState<Input> {
  if (state.phase === "ambiguous") {
    return editing(state, {
      tone: "caution",
      message: `Transaction ${state.digest} is still unresolved. Check it before you sign again.`,
    });
  }
  return ["succeeded", "failed", "rejected"].includes(state.phase) ? editing(state, null) : state;
}
