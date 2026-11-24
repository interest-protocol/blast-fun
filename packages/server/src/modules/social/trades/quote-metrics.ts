import { observeMetric } from "@blast/core/lib/metrics.ts";

/** Fixed quote boundaries only; never attach caller, coin, amount or provider data. */
type QuoteStage = "durable_quota" | "body_wallet_preparation" | "coin_read" | "route_discovery" | "fullnode_main" | "fullnode_reference" | "fullnode_wallet_balance";
type QuoteStageOutcome = "ok" | "error" | "refused" | "unavailable";

export function startQuoteStage(stage: QuoteStage): (outcome: QuoteStageOutcome) => void {
  let started: number;
  try {
    started = performance.now();
  } catch {
    return () => undefined;
  }
  return (outcome) => {
    try {
      observeMetric("social.trade_quote.stage", {
        stage,
        outcome,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      }, { sampleRate: outcome === "ok" ? 0.02 : 1 });
    } catch {
      // A telemetry clock or sink must never affect the quote.
    }
  };
}

/** Retains the exact operation result or thrown error; observation cannot change either. */
export async function observeQuoteStage<Result>(
  stage: QuoteStage,
  operation: () => Promise<Result>,
  outcomeOf: (result: Result) => QuoteStageOutcome = () => "ok",
): Promise<Result> {
  const finish = startQuoteStage(stage);
  let result: Result;
  try {
    result = await operation();
  } catch (error) {
    finish("error");
    throw error;
  }
  try {
    finish(outcomeOf(result));
  } catch {
    // Outcome classification is telemetry too; retain the operation’s result.
  }
  return result;
}
