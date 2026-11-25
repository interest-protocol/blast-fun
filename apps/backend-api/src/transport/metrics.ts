import { observeMetric } from "@blast/core/lib/metrics.ts";

export type PrivateResourceLane =
  | "quote"
  | "trade"
  | "long-work"
  | "upload"
  | "render"
  | "allowlist";

type AdmissionLane = PrivateResourceLane | "ordinary" | "readiness";

/** Permit observations only: admissions are sampled, capacity refusals are not. */
export function observeAdmission(
  lane: AdmissionLane,
  outcome: "admitted" | "busy",
  detail: Readonly<{
    work?: "quote" | "other";
    cause?: "capacity" | "draining" | "lane" | "aggregate";
  }> = {},
): void {
  observeMetric(
    "backend.admission",
    { lane, outcome, ...detail },
    { sampleRate: outcome === "admitted" ? 0.02 : 1 },
  );
}

export function observeTransportBusy(lane: "ordinary" | "readiness", draining: boolean): void {
  observeAdmission(lane, "busy", { cause: draining ? "draining" : "capacity" });
}
