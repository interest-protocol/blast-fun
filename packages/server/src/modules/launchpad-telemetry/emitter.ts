import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";
import { LaunchpadTelemetryRejection } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import type { RecordResult } from "@blast/server/modules/launchpad-telemetry/repository.ts";

/** What a telemetry call did. It never says anything about the product action. */
export type EmitResult = RecordResult | "rejected" | "dropped";

/** Whether a beacon may be recorded: its client's rate bucket decided, or telemetry was unavailable. */
export type AdmissionResult = "allowed" | "limited" | "dropped";

/** The longest a telemetry call may take before its answer is abandoned. */
export const LAUNCHPAD_TELEMETRY_TIMEOUT_MS = 1_500;

/** `LaunchpadTelemetryService` or anything with its recording methods. */
export interface LaunchpadTelemetrySink {
  admitCoinView(clientIp: string): Promise<"allowed" | "limited">;
  admitOutcomeReport(clientIp: string): Promise<"allowed" | "limited">;
  admitOutcomeCommitment(clientIp: string): Promise<"allowed" | "limited">;
  recordCoinView(visitorId: unknown, input: unknown): Promise<RecordResult>;
  recordOutcome(input: unknown): Promise<RecordResult>;
  recordOutcomeCommitment(visitorId: unknown, input: unknown, receivedAt?: Date): Promise<RecordResult>;
}

export interface LaunchpadTelemetryEmitter {
  /** Checks the client's rate bucket before anything is minted or recorded. */
  admitCoinView(clientIp: string): Promise<AdmissionResult>;
  /** Checks the client's outcome-report bucket before a node is read or anything recorded. */
  admitOutcomeReport(clientIp: string): Promise<AdmissionResult>;
  /** Checks the client's commitment bucket before anything is stored. */
  admitOutcomeCommitment(clientIp: string): Promise<AdmissionResult>;
  /** Counts a visitor's first view of a tradable coin. */
  recordCoinView(visitorId: unknown, input: unknown): Promise<EmitResult>;
  /** Records a flow's verified completed outcome for its event's sender, and decides its visitor link. */
  recordOutcome(input: unknown): Promise<EmitResult>;
  /** Stores a visitor's commitment of a signed transaction's digest, received at `receivedAt`. */
  recordOutcomeCommitment(visitorId: unknown, input: unknown, receivedAt?: Date): Promise<EmitResult>;
}

type EventLabel = "admission" | "outcome_admission" | "commitment_admission" | "coin_view" | "outcome" | "commitment";

/**
 * The server-side adapter product code uses. Every call resolves, never
 * rejects, and resolves within `timeoutMs` whatever the store does: a
 * timeout, a rejection, an outage, a saturated telemetry gate, an
 * unconfigured database or limiter, or malformed input is reported as
 * `dropped` or `rejected` and in a metric, and nothing else. A flow may `void` the call or pass it to `after()`; even awaiting it
 * cannot hold or change the action. The sink is created lazily so that a
 * failing pool accessor is absorbed too.
 *
 * Metrics carry the event, the result and a bounded reason only.
 */
export function createLaunchpadTelemetryEmitter(
  sink: () => LaunchpadTelemetrySink,
  options: { timeoutMs?: number; trackWork?: <T>(promise: Promise<T>) => Promise<T> } = {},
): LaunchpadTelemetryEmitter {
  const timeoutMs = options.timeoutMs ?? LAUNCHPAD_TELEMETRY_TIMEOUT_MS;

  async function emit<Settled extends string>(
    event: EventLabel,
    record: (target: LaunchpadTelemetrySink) => Promise<Settled>,
  ): Promise<Settled | "rejected" | "dropped"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    let result: Settled | "rejected" | "dropped";
    let reason: string | undefined;
    try {
      const recorded = (options.trackWork ?? ((promise) => promise))(Promise.resolve().then(() => record(sink())));
      // A late failure after the timeout has nobody to report to.
      recorded.catch(() => undefined);
      const outcome = await Promise.race([recorded, timedOut]);
      if (outcome === "timeout") {
        result = "dropped";
        reason = "timeout";
      } else {
        result = outcome as Settled;
      }
    } catch (error) {
      if (error instanceof LaunchpadTelemetryRejection) {
        result = "rejected";
        reason = error.reason;
      } else {
        result = "dropped";
        reason = errorLabel(error);
      }
    } finally {
      clearTimeout(timer);
    }
    try {
      recordMetric("launchpad.telemetry", { event, result, ...(reason ? { reason } : {}) });
    } catch {
      // Logging must not fail the caller either.
    }
    return result;
  }

  return {
    admitCoinView: async (clientIp) => {
      const result = await emit("admission", (target) => target.admitCoinView(clientIp));
      // Admission input is not validated by a parser, so nothing is "rejected".
      return result === "rejected" ? "dropped" : result;
    },
    admitOutcomeReport: async (clientIp) => {
      const result = await emit("outcome_admission", (target) => target.admitOutcomeReport(clientIp));
      return result === "rejected" ? "dropped" : result;
    },
    admitOutcomeCommitment: async (clientIp) => {
      const result = await emit("commitment_admission", (target) => target.admitOutcomeCommitment(clientIp));
      return result === "rejected" ? "dropped" : result;
    },
    recordCoinView: (visitorId, input) =>
      emit("coin_view", (target) => target.recordCoinView(visitorId, input)),
    recordOutcome: (input) => emit("outcome", (target) => target.recordOutcome(input)),
    recordOutcomeCommitment: (visitorId, input, receivedAt) =>
      emit("commitment", (target) => target.recordOutcomeCommitment(visitorId, input, receivedAt)),
  };
}
