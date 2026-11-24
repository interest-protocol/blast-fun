import { safeRouteHandler } from "@blast/core/lib/http-errors.ts";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { defineBlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import { decodeLaunchpadEvent, launchpadEventBcs, type DecodedLaunchpadEvent } from "@interest-protocol/blast-sdk/launchpad";
import { TransactionError, type SuiClientTypes } from "@mysten/sui/client";
import { normalizeSuiAddress, parseStructTag } from "@mysten/sui/utils";

import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type { LaunchReadChain } from "@blast/server/modules/launchpad-coin/fresh.ts";
import {
  LaunchpadTelemetryRejection,
  parseOutcomeReport,
  type CompletedEvent,
  type OutcomeReport,
  type RejectionReason,
} from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import type { LaunchpadTelemetryEmitter } from "@blast/server/modules/launchpad-telemetry/emitter.ts";
import {
  LAUNCHPAD_TELEMETRY_BODY_DEADLINE_MS,
  LAUNCHPAD_TELEMETRY_BODY_LIMIT,
  boundedText,
  sameOrigin,
  visitorIdFromRequest,
} from "@blast/server/modules/launchpad-telemetry/http.ts";

/**
 * Why a report names no completed event this route records. Bounded labels:
 * safe as metric fields and in responses, and never an echo of input.
 */
export type OutcomeRefusal =
  | "unknown-transaction"
  | "failed"
  | "not-checkpointed"
  | "foreign-lineage"
  | "other-launch"
  | "not-a-launch"
  | "not-a-buy"
  | "settlement-buy";

/** Why the node could not answer now; the client may report again later. */
export type OutcomeUnavailable = "node-unconfigured" | "wrong-network" | "node-unavailable" | "node-busy";

export type OutcomeVerdict =
  /** `senderWallet` is the completed event's native `sender` (the transaction sender), normalized. */
  | Readonly<{ status: "verified"; senderWallet: string; completion: CompletedEvent }>
  | Readonly<{ status: "refused"; reason: OutcomeRefusal }>
  | Readonly<{ status: "unavailable"; reason: OutcomeUnavailable }>;

export type OutcomeVerifier = (report: OutcomeReport) => Promise<OutcomeVerdict>;

/**
 * The pot's settlement buys: `settle_opening_round` emits the pot's `Bought`
 * and then its launch's `OpeningRoundSettled`, so each settlement's buy is the
 * last `Bought` of that launch before it (as blast-infra classifies it).
 */
function settlementBuys(events: readonly DecodedLaunchpadEvent[]): Set<DecodedLaunchpadEvent> {
  const settlements = new Set<DecodedLaunchpadEvent>();
  events.forEach((entry, index) => {
    if (entry.kind !== "OpeningRoundSettled") return;
    const pot = events
      .slice(0, index)
      .findLast((earlier) => earlier.kind === "Bought" && earlier.payload.launch_id === entry.payload.launch_id);
    if (pot) settlements.add(pot);
  });
  return settlements;
}

type Match = Readonly<{ event: DecodedLaunchpadEvent }> | Readonly<{ reason: OutcomeRefusal }>;

/** Whether a different package emitted a launchpad-shaped event. */
function foreignLaunchEvent(eventType: string, originalPackageId: string): boolean {
  try {
    const tag = parseStructTag(eventType);
    return tag.module === "events" && Object.hasOwn(launchpadEventBcs, tag.name) && tag.address !== normalizeSuiAddress(originalPackageId);
  } catch {
    return false;
  }
}

/**
 * The completed event `report` names in the transaction, or why there is
 * none. Only events of the deployment's launchpad lineage count; a
 * launchpad-shaped event of another package is `foreign-lineage`.
 */
function match(
  report: OutcomeReport,
  transaction: SuiClientTypes.Transaction<{ events: true }>,
  originalPackageId: string,
  checkpoint: string,
): Match {
  let foreign = false;
  const events = transaction.events.flatMap((entry, eventIndex): DecodedLaunchpadEvent[] => {
    try {
      const position = { checkpoint, transactionDigest: report.txDigest, eventIndex };
      return [decodeLaunchpadEvent({ ...entry, ...position }, { originalPackageId })];
    } catch {
      foreign ||= foreignLaunchEvent(entry.eventType, originalPackageId);
      return [];
    }
  });
  const wanted = report.kind === "launch" ? "LaunchShared" : "Bought";
  const ofKind = events.filter((entry) => entry.kind === wanted);
  const ofLaunch = (entry: DecodedLaunchpadEvent) => "launch_id" in entry.payload && entry.payload.launch_id === report.launchId;
  if (report.kind === "launch") {
    const shared = ofKind.find(ofLaunch);
    if (shared) return { event: shared };
  } else {
    const settlements = settlementBuys(events);
    const buys = ofKind.filter(ofLaunch);
    const buy = buys.find((entry) => !settlements.has(entry));
    if (buy) return { event: buy };
    if (buys.length > 0) return { reason: "settlement-buy" };
  }
  const notThat = report.kind === "launch" ? "not-a-launch" : "not-a-buy";
  if (events.some(ofLaunch)) return { reason: notThat };
  if (ofKind.length > 0) return { reason: "other-launch" };
  return { reason: foreign ? "foreign-lineage" : notThat };
}

/** The longest a report's node reads (chain identity and transaction) may take. */
export const OUTCOME_READ_TIMEOUT_MS = 2_000;
/** Node reads in flight per process; a report beyond them is refused, never queued. */
export const OUTCOME_READ_CONCURRENCY = 8;

class ReadTimeout extends Error {}

/** The node reads a completed-event verifier makes. */
export type CompletedEventNode = Readonly<{
  core: Readonly<{
    getChainIdentifier(options: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ chainIdentifier: string }>>;
    getTransaction(
      options: Readonly<{ digest: string; include: Readonly<{ events: true }>; signal?: AbortSignal }>,
    ): Promise<SuiClientTypes.TransactionResult<{ events: true }>>;
  }>;
}>;

/** Where a verifier reads: the node, the chain it must answer for, and the package lineage whose events count. */
export type CompletedEventSource = Readonly<{
  client: CompletedEventNode;
  chainIdentifier: string;
  originalPackageId: string;
}>;

/** Why a transaction holds no completed event at all, before any event is matched. */
export type TransactionRefusal = "unknown-transaction" | "failed" | "not-checkpointed";

/** The index of the event a report names in its transaction, or why there is none. */
export type CompletedEventMatch<Refusal extends string> = Readonly<{ eventIndex: number }> | Readonly<{ reason: Refusal }>;

export type CompletedEventVerdict<Refusal extends string> =
  /** `senderWallet` is the completed event's native `sender` (the transaction sender), normalized. */
  | Readonly<{ status: "verified"; senderWallet: string; completion: CompletedEvent }>
  | Readonly<{ status: "refused"; reason: TransactionRefusal | Refusal }>
  | Readonly<{ status: "unavailable"; reason: OutcomeUnavailable }>;

/**
 * The bounded node read every verified-outcome route shares (launchpad and
 * presale). `configured` is the deployment's node configuration (null when
 * none); `source` names its node, chain and lineage. The node must answer for
 * the chain identifier (checked once per node and process); the transaction
 * must have executed successfully and be in a checkpoint with a time; and
 * `match` names the completed event of the configured lineage the report
 * means. The event's native sender, the checkpoint, the event's position and
 * the checkpoint's time come from the node, never from the report. Reads run
 * with at most `maxConcurrent` in flight (another report is `node-busy` at
 * once), are abandoned after `timeoutMs`, and never wait for a transaction to
 * be confirmed: a pending one is refused at once. Never throws.
 */
export function createCompletedEventVerifier<
  Configured,
  Report extends Readonly<{ txDigest: string }>,
  Refusal extends string,
>(input: Readonly<{
  configured: () => Promise<Configured | null>;
  source: (configured: Configured) => CompletedEventSource;
  match: (
    report: Report,
    transaction: SuiClientTypes.Transaction<{ events: true }>,
    originalPackageId: string,
    checkpoint: string,
  ) => CompletedEventMatch<Refusal>;
  timeoutMs?: number;
  maxConcurrent?: number;
  trackWork?: <T>(promise: Promise<T>) => Promise<T>;
}>): (report: Report) => Promise<CompletedEventVerdict<Refusal>> {
  const timeoutMs = input.timeoutMs ?? OUTCOME_READ_TIMEOUT_MS;
  const maxConcurrent = input.maxConcurrent ?? OUTCOME_READ_CONCURRENCY;
  let inFlight = 0;
  // The node's chain identifier, once it matched; a node's genesis never changes.
  let verifiedNode: CompletedEventNode | null = null;

  async function read(configured: Configured, report: Report, signal: AbortSignal): Promise<CompletedEventVerdict<Refusal>> {
    const { client, chainIdentifier, originalPackageId } = input.source(configured);
    if (verifiedNode !== client) {
      const node = await client.core.getChainIdentifier({ signal });
      if (node.chainIdentifier !== chainIdentifier) return { status: "unavailable", reason: "wrong-network" };
      verifiedNode = client;
    }
    let result: SuiClientTypes.TransactionResult<{ events: true }>;
    try {
      result = await client.core.getTransaction({ digest: report.txDigest, include: { events: true }, signal });
    } catch (error) {
      if (error instanceof TransactionError && error.reason === "notFound") {
        return { status: "refused", reason: "unknown-transaction" };
      }
      throw error;
    }
    const transaction = result.Transaction ?? result.FailedTransaction;
    if (!transaction?.status.success) return { status: "refused", reason: "failed" };
    if (transaction.checkpoint === null || transaction.timestampMs === null) {
      return { status: "refused", reason: "not-checkpointed" };
    }
    const found = input.match(report, transaction, originalPackageId, transaction.checkpoint);
    if ("reason" in found) return { status: "refused", reason: found.reason };
    const { eventIndex } = found;
    return {
      status: "verified",
      senderWallet: normalizeSuiAddress(transaction.events[eventIndex]!.sender),
      completion: {
        status: "completed",
        checkpoint: Number(transaction.checkpoint),
        txDigest: report.txDigest,
        eventSeq: eventIndex,
        completedAt: new Date(transaction.timestampMs).toISOString(),
      },
    };
  }

  return async (report) => {
    let configured: Configured | null;
    try {
      configured = await input.configured();
    } catch {
      configured = null;
    }
    if (!configured) return { status: "unavailable", reason: "node-unconfigured" };
    if (inFlight >= maxConcurrent) return { status: "unavailable", reason: "node-busy" };
    inFlight += 1;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ReadTimeout());
      }, timeoutMs);
    });
    try {
      const reading = (input.trackWork ?? ((promise) => promise))(
        Promise.resolve().then(() => read(configured, report, controller.signal)),
      );
      // A visible timeout cannot free the actual provider concurrency slot.
      void reading.then(() => { inFlight -= 1; }, () => { inFlight -= 1; });
      reading.catch(() => undefined);
      return await Promise.race([reading, deadline]);
    } catch {
      return { status: "unavailable", reason: "node-unavailable" };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Verifies reported outcomes against the deployment's configured node
 * (`chain`, null when none is configured), with the shared bounded read
 * (`createCompletedEventVerifier`). The transaction must hold the completed
 * configured-lineage event the report names:
 *
 * - `launch`: the `LaunchShared` of the launch;
 * - `buy`: a `Bought` of the launch that is not the opening round's
 *   settlement buy (the first such, when there are several).
 */
export function createOutcomeVerifier(
  chain: () => Promise<LaunchReadChain | null>,
  options: Readonly<{ timeoutMs?: number; maxConcurrent?: number; trackWork?: <T>(promise: Promise<T>) => Promise<T> }> = {},
): OutcomeVerifier {
  return createCompletedEventVerifier({
    configured: chain,
    source: (configured) => {
      const deployment = defineBlastDeployment(configured.manifest);
      return {
        client: configured.client,
        chainIdentifier: deployment.chainIdentifier,
        originalPackageId: deployment.packages.launchpad.originalPackageId,
      };
    },
    match: (report: OutcomeReport, transaction, originalPackageId, checkpoint) => {
      const found = match(report, transaction, originalPackageId, checkpoint);
      return "reason" in found ? found : { eventIndex: found.event.position.eventIndex };
    },
    ...options,
  });
}

/** Why the route answered without recording. Bounded labels; never input. */
export type OutcomeRouteReason =
  | OutcomeRefusal
  | OutcomeUnavailable
  /** The report's exact parse (`parseOutcomeReport`): `shape`, `event`, `launch-id` or `digest`. */
  | RejectionReason
  | "origin"
  | "content-type"
  | "too-large"
  | "body-timeout"
  | "malformed"
  | "no-visitor"
  | "rate-limited"
  | "limiter-unavailable"
  | "unrecordable"
  | "storage-unavailable";

/** What a verified Privy session tells this route: only the user's embedded Sui wallet. */
export type PrivySessionWallet = (accessToken: string) => Promise<Readonly<{ suiWalletAddress: string | null }>>;

export interface LaunchpadOutcomeRouteDependencies {
  emitter: LaunchpadTelemetryEmitter;
  verify: OutcomeVerifier;
  /** The site's canonical origin; a request with another `Origin` is refused. */
  expectedOrigin: string;
  bodyDeadlineMs?: number;
  /**
   * Verifies a report's Privy access token (`createPrivySessionVerifier`).
   * Without it, or when it fails or runs past `privyTimeoutMs`, no report is
   * linked through a Privy session; the report is still recorded.
   */
  verifyPrivySession?: PrivySessionWallet;
  privyTimeoutMs?: number;
}

/** The longest a report waits for Privy; past it the outcome is recorded without a Privy link. */
export const OUTCOME_PRIVY_TIMEOUT_MS = 2_000;

// As the launchpad's protected writes read it (`launchpad-identity/mutation.ts`).
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$/;

/** The request's Privy access token, or null for no or a malformed `Authorization` header. */
function bearerToken(request: Request): string | null {
  return request.headers.get("authorization")?.match(BEARER)?.[1] ?? null;
}

/**
 * The reporter's verified Privy session: its embedded Sui wallet (normalized),
 * `null` for a session without one, or `undefined` when Privy refused the
 * token, failed or ran past `timeoutMs` (with a bounded `outcome_privy`
 * `dropped` metric). It never refuses the report.
 */
async function privySessionHolds(
  verifyPrivySession: PrivySessionWallet,
  accessToken: string,
  timeoutMs: number,
): Promise<string | null | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const verifying = Promise.resolve().then(() => verifyPrivySession(accessToken));
    verifying.catch(() => undefined);
    const session = await Promise.race([verifying, deadline]);
    if (session === "timeout") {
      recordMetric("launchpad.telemetry", { event: "outcome_privy", result: "dropped", reason: "timeout" });
      return undefined;
    }
    return session.suiWalletAddress === null ? null : normalizeSuiAddress(session.suiWalletAddress);
  } catch (error) {
    recordMetric("launchpad.telemetry", { event: "outcome_privy", result: "dropped", reason: errorLabel(error) });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const BODY_REFUSALS = { 400: "malformed", 408: "body-timeout", 413: "too-large" } as const;

function respond(status: number, body: Readonly<Record<string, string>>): Response {
  return publicJson(body, { status, headers: { "Cache-Control": "no-store" } });
}

type RouteEvent = "outcome_report" | "outcome_commitment";

/** Answers `{ reason }` and records a metric with the event, result, reason and kind only. */
function refuse(event: RouteEvent, status: number, reason: OutcomeRouteReason, kind?: string): Response {
  recordMetric("launchpad.telemetry", {
    event,
    result: status >= 500 ? "dropped" : "rejected",
    reason,
    ...(kind ? { kind } : {}),
  });
  return respond(status, { reason });
}

function jsonContent(request: Request): boolean {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return type === "application/json";
}

/**
 * The guards both outcome routes apply before anything is read or written:
 * same origin (403), `application/json` (415), a body bounded in size (413)
 * and time (408) and parsed exactly as `{ kind, launchId, txDigest }` (400).
 */
async function readReport(
  event: RouteEvent,
  request: Request,
  expectedOrigin: string,
  deadlineMs: number,
): Promise<Readonly<{ report: OutcomeReport }> | Readonly<{ refused: Response }>> {
  if (!sameOrigin(request, expectedOrigin)) return { refused: refuse(event, 403, "origin") };
  if (!jsonContent(request)) return { refused: refuse(event, 415, "content-type") };
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > LAUNCHPAD_TELEMETRY_BODY_LIMIT) return { refused: refuse(event, 413, "too-large") };
  const read = await boundedText(request, LAUNCHPAD_TELEMETRY_BODY_LIMIT, deadlineMs);
  if ("refused" in read) return { refused: refuse(event, read.refused, BODY_REFUSALS[read.refused]) };
  try {
    return { report: parseOutcomeReport(JSON.parse(read.text)) };
  } catch (error) {
    if (error instanceof SyntaxError) return { refused: refuse(event, 400, "malformed") };
    if (error instanceof LaunchpadTelemetryRejection) return { refused: refuse(event, 400, error.reason) };
    throw error;
  }
}

/**
 * `POST /api/launchpad/outcomes`: anyone same-origin reports the digest of a
 * completed launch or curve Buy, and the server records it once as a verified
 * outcome of the wallet that sent the event. The body is exactly
 * `{ kind: "launch" | "buy", launchId, txDigest }`, with an optional
 * `Authorization: Bearer <Privy access token>` header. In order, and nothing
 * is read or written before step 4:
 *
 * 1. Another site, a sibling subdomain or a foreign `Origin`: 403.
 * 2. A body that is not `application/json`: 415.
 * 3. The body is bounded in size (413) and time (408), and parsed exactly
 *    (400, with the field's bounded reason).
 * 4. The client IP's rate bucket (`launchpad_outcome`): 429 when full, 503
 *    when the limiter cannot answer.
 * 5. The configured node verifies the completed event (`createOutcomeVerifier`):
 *    422 with the refusal's reason, 503 when the node cannot answer now. When
 *    the report carries a Bearer token and the visitor cookie, Privy is asked
 *    alongside for the session's wallet; it never refuses or delays the
 *    report past `privyTimeoutMs`.
 * 6. The outcome is recorded for the event's `sender` with the chain's
 *    checkpoint, time and position, and its visitor link is decided
 *    (`LaunchpadTelemetryRepository.recordOutcome`): the reporting visitor
 *    when its Privy session's wallet is the sender, else the digest's
 *    commitment decision, else none. 201 `recorded`, 200 `duplicate` (one
 *    completed event is one outcome; its facts never change), 503 when
 *    storage is unavailable. A report without a visitor cookie is recorded
 *    like any other; the cookie never decides attribution.
 *
 * Every refusal answers `{ reason }` and records a `launchpad.telemetry`
 * metric with the event, result, reason and kind only. Responses are never
 * cached and never say whether or to whom an outcome is linked. The browser
 * reporter retries once after a 503 and never after a 4xx.
 */
export function createLaunchpadOutcomeRouteHandler(
  dependencies: LaunchpadOutcomeRouteDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  const deadlineMs = dependencies.bodyDeadlineMs ?? LAUNCHPAD_TELEMETRY_BODY_DEADLINE_MS;
  const refused = (status: number, reason: OutcomeRouteReason, kind?: string) => refuse("outcome_report", status, reason, kind);
  return safeRouteHandler(async (request: Request, client: ClientAddress) => {
    const read = await readReport("outcome_report", request, dependencies.expectedOrigin, deadlineMs);
    if ("refused" in read) return read.refused;
    const { report } = read;

    const admission = await dependencies.emitter.admitOutcomeReport(client.rateKey);
    if (admission === "limited") return refused(429, "rate-limited", report.kind);
    if (admission === "dropped") return refused(503, "limiter-unavailable", report.kind);

    // Privy can link only a visitor that reported with its own session; it is
    // asked alongside the node, and never decides whether the report counts.
    const visitorId = visitorIdFromRequest(request);
    const accessToken = bearerToken(request);
    const privyWallet =
      visitorId && accessToken && dependencies.verifyPrivySession
        ? privySessionHolds(dependencies.verifyPrivySession, accessToken, dependencies.privyTimeoutMs ?? OUTCOME_PRIVY_TIMEOUT_MS)
        : Promise.resolve(undefined);
    const verdict = await dependencies.verify(report);
    if (verdict.status === "unavailable") return refused(503, verdict.reason, report.kind);
    if (verdict.status === "refused") return refused(422, verdict.reason, report.kind);

    const sessionWallet = await privyWallet;
    // A verified session that holds another wallet, or none, links no one: a bounded metric shows it.
    if (sessionWallet !== undefined && sessionWallet !== verdict.senderWallet) {
      const reason = sessionWallet === null ? "no-wallet" : "other-wallet";
      recordMetric("launchpad.telemetry", { event: "outcome_privy", result: "rejected", reason, kind: report.kind });
    }
    const link =
      visitorId && sessionWallet === verdict.senderWallet
        ? ({ visitorId, visitorLink: "privy_session" } as const)
        : ({ visitorId: null } as const);
    const result = await dependencies.emitter.recordOutcome({
      kind: report.kind,
      launchId: report.launchId,
      senderWallet: verdict.senderWallet,
      ...link,
      completion: verdict.completion,
    });
    switch (result) {
      case "recorded": return respond(201, { result });
      case "duplicate": return respond(200, { result });
      case "rejected": return refused(422, "unrecordable", report.kind);
    }
    return refused(503, "storage-unavailable", report.kind);
  });
}

export interface LaunchpadOutcomeCommitmentRouteDependencies {
  emitter: LaunchpadTelemetryEmitter;
  /** The site's canonical origin; a request with another `Origin` is refused. */
  expectedOrigin: string;
  bodyDeadlineMs?: number;
  /** Server time, read once when a request's body has arrived: the commitment's receipt time. */
  clock?: () => Date;
}

/**
 * `POST /api/launchpad/outcomes/commitments`: just before it submits a signed
 * launch or Buy, a browser commits the transaction's digest as its visitor's
 * own. The body is exactly `{ kind: "launch" | "buy", launchId, txDigest }`.
 * In order, and nothing is read or written before step 3:
 *
 * 1. The outcome route's guards: 403, 415, 413, 408, 400.
 * 2. Without the first-party visitor cookie there is no one to link: 422
 *    `no-visitor`. The route never mints a visitor.
 * 3. The client IP's rate bucket (`launchpad_outcome_commitment`): 429 when
 *    full, 503 when the limiter cannot answer.
 * 4. `(digest, visitor)` is stored once with the server's receipt time, read
 *    as soon as the body has arrived (a client cannot pre-date it by opening
 *    the request before it knows the digest) and before the rate check (a
 *    slow limiter does not move it later): 201 `recorded`, 200 `duplicate`,
 *    503 when storage is unavailable. No node is read and no outcome is
 *    recorded; the outcome route decides the link.
 *
 * Refusals answer `{ reason }` with a `launchpad.telemetry` metric
 * (`event: "outcome_commitment"`, result, reason and kind only). Responses
 * are never cached, and the response never says whether a link follows.
 */
export function createLaunchpadOutcomeCommitmentRouteHandler(
  dependencies: LaunchpadOutcomeCommitmentRouteDependencies,
): (request: Request, client: ClientAddress) => Promise<Response> {
  const deadlineMs = dependencies.bodyDeadlineMs ?? LAUNCHPAD_TELEMETRY_BODY_DEADLINE_MS;
  const refused = (status: number, reason: OutcomeRouteReason, kind?: string) => refuse("outcome_commitment", status, reason, kind);
  const clock = dependencies.clock ?? (() => new Date());
  return safeRouteHandler(async (request: Request, client: ClientAddress) => {
    const read = await readReport("outcome_commitment", request, dependencies.expectedOrigin, deadlineMs);
    if ("refused" in read) return read.refused;
    const receivedAt = clock();
    const { report } = read;

    const visitorId = visitorIdFromRequest(request);
    if (!visitorId) return refused(422, "no-visitor", report.kind);

    const admission = await dependencies.emitter.admitOutcomeCommitment(client.rateKey);
    if (admission === "limited") return refused(429, "rate-limited", report.kind);
    if (admission === "dropped") return refused(503, "limiter-unavailable", report.kind);

    const result = await dependencies.emitter.recordOutcomeCommitment(visitorId, report, receivedAt);
    if (result === "recorded") return respond(201, { result });
    if (result === "duplicate") return respond(200, { result });
    if (result === "rejected") return refused(422, "unrecordable", report.kind);
    return refused(503, "storage-unavailable", report.kind);
  });
}
