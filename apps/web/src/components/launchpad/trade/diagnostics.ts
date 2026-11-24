// Curve trade diagnostics: the funnel (review shown, signature requested,
// abandoned, rejected, failed), and completion with its latency, execution
// delta, and repeat trading, derived from the shared action states and the
// completed trade event. Every property comes from a closed list: no amounts,
// addresses, digests, or input. A completion is reported once per digest and
// only from the completed event; only a completed `Bought` is a conversion.
// These are client diagnostics, not outcomes: the conversion that counts is
// the server-verified Buy outcome, which the rail reports at the same point
// (`curveCompletionHandler`, `outcomes.ts`; docs/launchpad/trades.md).

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import type { ActionState, MaterialFact, PreflightBlockCode } from "../transaction/action-machine.ts";
import { curveAbortOf } from "./aborts.ts";
import { parseFormattedAtomic } from "./amount.ts";
import type { CompletedTrade } from "./completed-trade.ts";
import type { CurveTradeInput, TradeDirection } from "./curve-adapter.ts";

export type FailureReason = PreflightBlockCode | "slippage" | "lifecycle" | "zero-output" | "execution" | "signature";

export type CurveDiagnostic =
  | Readonly<{ event: "curve_review_shown"; direction: TradeDirection }>
  | Readonly<{ event: "curve_review_replaced"; direction: TradeDirection }>
  | Readonly<{ event: "curve_signature_requested"; direction: TradeDirection }>
  | Readonly<{ event: "curve_review_abandoned"; direction: TradeDirection }>
  | Readonly<{ event: "curve_rejected"; direction: TradeDirection }>
  | Readonly<{ event: "curve_failed"; direction: TradeDirection; stage: "preflight" | "signature" | "execution"; reason: FailureReason }>
  | Readonly<{
      event: "curve_completed";
      direction: TradeDirection;
      latency: "<2s" | "2-5s" | "5-15s" | ">15s";
      delta: "exact" | "within-0.1%" | "within-1%" | "beyond-1%" | "unknown";
      repeat: "first" | "repeat";
    }>
  | Readonly<{ event: "curve_conversion" }>;

/** The curve abort a failure reports, through the shared package-checked parser; otherwise `execution`. */
function executionReason(message: string, deployment: BlastDeployment | null): FailureReason {
  return curveAbortOf(message, deployment) ?? "execution";
}

type State = ActionState<CurveTradeInput>;

/** The funnel steps between two states; `previous` is null for the state a page opened with. */
export function curveDiagnostics(
  previous: State | null,
  next: State,
  direction: TradeDirection,
  deployment: BlastDeployment | null = null,
): CurveDiagnostic[] {
  if (previous === null || (previous.phase === next.phase && previous.attempt === next.attempt)) return [];
  switch (next.phase) {
    case "review":
      return reviewDiagnostics(previous, next, direction);
    case "signing":
      return previous.phase === "signing" ? [] : [{ event: "curve_signature_requested", direction }];
    case "editing":
      return previous.phase === "review" ? [{ event: "curve_review_abandoned", direction }] : [];
    case "rejected":
      return [{ event: "curve_rejected", direction }];
    case "blocked":
      return [{ event: "curve_failed", direction, stage: "preflight", reason: next.block.code }];
    case "failed":
      return [
        {
          event: "curve_failed",
          direction,
          stage: next.stage,
          reason: next.stage === "signature" ? "signature" : executionReason(next.message, deployment),
        },
      ];
    default:
      return [];
  }
}

function reviewDiagnostics(previous: State, next: Extract<State, { phase: "review" }>, direction: TradeDirection): CurveDiagnostic[] {
  if (previous.phase !== "review" && previous.phase !== "preflighting") return [];
  if (next.changes.length > 0) return [{ event: "curve_review_replaced", direction }];
  return previous.phase === "review" ? [] : [{ event: "curve_review_shown", direction }];
}

export type TradeLedger = Readonly<{
  reported(digest: string): boolean;
  /** Records a completed trade on `launchId`; returns how many this browser completed there before. */
  record(digest: string, launchId: string): number;
}>;

const LEDGER_KEY = "blast:launchpad:curve-trades:v1";
const LEDGER_LIMIT = 200;

type LedgerStorage = Pick<Storage, "getItem" | "setItem">;
type LedgerEntries = { digests: string[]; launches: Record<string, number> };

/** Digests already reported and trades per launch, in this browser; in-page memory if storage fails. */
export function tradeLedger(storage: () => LedgerStorage = () => window.localStorage): TradeLedger {
  let memory: LedgerEntries = { digests: [], launches: {} };
  const read = (): LedgerEntries => {
    try {
      const parsed = JSON.parse(storage().getItem(LEDGER_KEY) ?? "null") as LedgerEntries | null;
      if (parsed && Array.isArray(parsed.digests) && parsed.launches && typeof parsed.launches === "object") return parsed;
    } catch {
      // Fall back to this page's memory.
    }
    return memory;
  };
  return {
    reported: (digest) => read().digests.includes(digest),
    record(digest, launchId) {
      const entries = read();
      const before = entries.launches[launchId] ?? 0;
      memory = {
        digests: [...entries.digests.filter((entry) => entry !== digest), digest].slice(-LEDGER_LIMIT),
        launches: { ...entries.launches, [launchId]: before + 1 },
      };
      try {
        storage().setItem(LEDGER_KEY, JSON.stringify(memory));
      } catch {
        // In-page memory still prevents a repeat here.
      }
      return before;
    },
  };
}

function latencyBucket(ms: number): Extract<CurveDiagnostic, { event: "curve_completed" }>["latency"] {
  if (ms < 2_000) return "<2s";
  if (ms < 5_000) return "2-5s";
  if (ms < 15_000) return "5-15s";
  return ">15s";
}

/** How far the completed amount landed from the reviewed one. */
function deltaBucket(expected: bigint | null, actual: bigint): Extract<CurveDiagnostic, { event: "curve_completed" }>["delta"] {
  if (expected === null || expected === 0n) return "unknown";
  const difference = actual > expected ? actual - expected : expected - actual;
  if (difference === 0n) return "exact";
  const bps = (difference * 10_000n) / expected;
  if (bps < 10n) return "within-0.1%";
  if (bps < 100n) return "within-1%";
  return "beyond-1%";
}

/** The reviewed amount a fact showed ("1,234.5 TOAD"), in atoms; null when it is absent. */
function reviewedAtoms(facts: readonly MaterialFact[], key: string, decimals: number): bigint | null {
  const value = facts.find((fact) => fact.key === key)?.value;
  return value ? parseFormattedAtomic(value.split(" ")[0] ?? "", decimals) : null;
}

/**
 * The completion of one trade, from its completed event; nothing without one,
 * and nothing for a digest already reported.
 */
export function completionDiagnostics({
  direction,
  launchId,
  digest,
  facts,
  decimals,
  trade,
  latencyMs,
  ledger,
}: Readonly<{
  direction: TradeDirection;
  launchId: string;
  digest: string;
  facts: readonly MaterialFact[];
  /** Decimals of the amount the trade receives (the coin for a buy, SUI for a sale); null when unknown. */
  decimals: number | null;
  trade: CompletedTrade | null;
  latencyMs: number;
  ledger: TradeLedger;
}>): CurveDiagnostic[] {
  const expectedKind = direction === "buy" ? "Bought" : "Sold";
  if (!trade || trade.kind !== expectedKind || ledger.reported(digest)) return [];
  const before = ledger.record(digest, launchId);
  const delta =
    trade.kind === "Bought"
      ? deltaBucket(decimals === null ? null : reviewedAtoms(facts, "meme-out", decimals), trade.memeOutNet)
      : deltaBucket(decimals === null ? null : reviewedAtoms(facts, "quote-out", decimals), trade.quoteOutNet);
  const completed: CurveDiagnostic = { event: "curve_completed", direction, latency: latencyBucket(latencyMs), delta, repeat: before > 0 ? "repeat" : "first" };
  return trade.kind === "Bought" ? [completed, { event: "curve_conversion" }] : [completed];
}

export type DiagnosticsTransport = (name: string, properties: Record<string, string>) => void;

/** A reporter that never throws, never awaits, and cannot change the trade. */
export function createCurveDiagnosticsReporter(send: DiagnosticsTransport): (diagnostic: CurveDiagnostic) => void {
  return (diagnostic) => {
    try {
      send("launchpad_curve", { ...diagnostic });
    } catch {
      // Diagnostics are optional; trading carries on.
    }
  };
}
