
import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";
import type { ClientWithCoreApi } from "@mysten/sui/client";

import { track } from "@vercel/analytics";
import { commitSignedOutcome, type VerifiedOutcomeReport } from "#web/modules/launchpad-telemetry/client.ts";
import type { OutcomeReport } from "@blast/core/modules/launchpad-telemetry/contracts.ts";
import type { ActionState } from "../transaction/action-machine";
import { createActionController, type ActionController, type CaptureConfirmation, type SignerSource } from "../transaction/controller";

import type { LaunchpadChain } from "../transaction/preflight";
import type { LaunchpadSigner } from "../transaction/signer";
import { freshTrade } from "./amount";
import { readCompletedTrade, type CompletedTrade } from "./completed-trade";
import { curveTradeAdapter, type CurveTradeInput, type TradeDirection } from "./curve-adapter";

import { completionDiagnostics, createCurveDiagnosticsReporter, curveDiagnostics, type CurveDiagnostic, type TradeLedger } from "./diagnostics";
import { commitSignedBuy, reportCompletedBuy, signingPrivySession } from "./outcomes";

export const DEFAULT_SLIPPAGE_BPS = 100n;

/** Curve diagnostics through the site's analytics: closed lists only, never blocking. */
export const reportCurveToAnalytics = createCurveDiagnosticsReporter((name, properties) => track(name, properties));

/**
 * The trade whose submission answer was lost (T-004's ambiguity), if any.
 * While one exists, it can only be reconciled by digest, and no new review
 * opens in either direction.
 */
export function unresolvedTrade<Input = CurveTradeInput>(
  states: Readonly<Record<TradeDirection, ActionState<Input>>>,
): Readonly<{ direction: TradeDirection; digest: string }> | null {
  for (const direction of ["buy", "sell"] as const) {
    const state = states[direction];
    if (state.phase === "ambiguous") return { direction, digest: state.digest };
  }
  return null;
}

export type Controllers = Readonly<Record<TradeDirection, ActionController<CurveTradeInput>>>;

export type Succeeded = Extract<ActionState<CurveTradeInput>, { phase: "succeeded" }>;

/**
 * Both directions' controllers for one launch. The Buy's controller commits
 * each signed digest as this browser's own (`commitOutcome`, by default
 * `commitSignedOutcome`) after the signature and before the submission,
 * without waiting for it; a Sale commits nothing.
 */
export function createCurveTradeControllers({
  chain,
  signers,
  launchId,
  commitOutcome = commitSignedOutcome,
  captureConfirmation,
}: Readonly<{
  chain: LaunchpadChain;
  signers: SignerSource;
  launchId: string;
  commitOutcome?: (outcome: OutcomeReport) => void;
  captureConfirmation?: (direction: TradeDirection, signer: LaunchpadSigner) => ReturnType<CaptureConfirmation>;
}>): Controllers {
  const create = (direction: TradeDirection) =>
    createActionController({
      adapter: curveTradeAdapter(direction),
      chain,
      signers,
      input: { launchId, direction, amount: "", slippageBps: DEFAULT_SLIPPAGE_BPS },
      restart: freshTrade,
      captureConfirmation: (signer) => captureConfirmation?.(direction, signer),
      ...(direction === "buy" ? { onSigned: commitSignedBuy(commitOutcome) } : {}),
    });
  return { buy: create("buy"), sell: create("sell") };
}

/**
 * Follows both directions' states: reports their diagnostics through a guard
 * (a reporter that throws never stops a trade, AC-147); reads the curve and
 * balances again when a review opens or is replaced and when the preflight
 * refuses (a wallet is connected by then); and hands each completion, with its
 * signing latency, to `onCompleted`. Returns the unsubscribe.
 */
export function watchCurveTrades(
  controllers: Controllers,
  {
    deployment,
    report,
    refresh,
    onCompleted,
  }: Readonly<{
    deployment: BlastDeployment;
    report(diagnostic: CurveDiagnostic): void;
    refresh(): void;
    onCompleted(direction: TradeDirection, state: Succeeded, latencyMs: number, reportSafely: (diagnostic: CurveDiagnostic) => void): void;
  }>,
): () => void {
  const reportSafely = (diagnostic: CurveDiagnostic) => {
    try {
      report(diagnostic);
    } catch {
      // Diagnostics are optional.
    }
  };
  const stops = (["buy", "sell"] as const).map((key) => {
    const controller = controllers[key];
    let previous = controller.getState();
    let signingSince: number | null = null;
    return controller.subscribe(() => {
      const next = controller.getState();
      for (const diagnostic of curveDiagnostics(previous, next, key, deployment)) reportSafely(diagnostic);
      if (next.phase === "review" && (previous.phase !== "review" || next.review.id !== previous.review.id)) refresh();
      if (next.phase === "blocked" && previous.phase !== "blocked") refresh();
      if (next.phase === "signing" && previous.phase !== "signing") signingSince = Date.now();
      if (next.phase === "succeeded" && previous.phase !== "succeeded") {
        onCompleted(key, next, signingSince === null ? 0 : Date.now() - signingSince, reportSafely);
      }
      previous = next;
    });
  });
  return () => stops.forEach((stop) => stop());
}

export type OnCompleted = Parameters<typeof watchCurveTrades>[1]["onCompleted"];

/**
 * What happens when a trade completes (`watchCurveTrades`' `onCompleted`):
 * the completed event is read from the node and handed to `onRead`; its
 * diagnostics are reported once per digest through `ledger`; and a completed
 * `Bought` that the ledger has not seen in this browser is reported to the
 * verified-outcome route (`reportOutcome`, `reportCompletedBuy`). A Sale, or
 * a transaction without the expected event, reports no outcome.
 */
export function curveCompletionHandler({
  client,
  deployment,
  launchId,
  ledger,
  decimals,
  signer,
  reportOutcome,
  privyTokenTimeoutMs,
  onRead = () => {},
}: Readonly<{
  client: ClientWithCoreApi;
  deployment: BlastDeployment;
  launchId: string;
  ledger: TradeLedger;
  /** Decimals of the amount a trade in `direction` receives; null when unknown. */
  decimals(direction: TradeDirection): number | null;
  /** The signer now connected; a Privy session's token goes with its own completed Buy's report. */
  signer(): LaunchpadSigner | null;
  reportOutcome(outcome: VerifiedOutcomeReport): void;
  /** The longest a report waits for the Privy session's token (`BUY_PRIVY_TOKEN_TIMEOUT_MS`). */
  privyTokenTimeoutMs?: number;
  onRead?(digest: string, read: CompletedTrade | "unavailable"): void;
}>): OnCompleted {
  return (direction, { digest, review }, latencyMs, reportSafely) => {
    void readCompletedTrade(client, deployment, digest).then((read) => {
      const trade = read.status === "ok" ? read.trade : null;
      onRead(digest, trade ?? "unavailable");
      const diagnostics = completionDiagnostics({
        direction,
        launchId,
        digest,
        facts: review.facts,
        decimals: decimals(direction),
        trade,
        latencyMs,
        ledger,
      });
      for (const diagnostic of diagnostics) reportSafely(diagnostic);
      // The ledger's first sight of this completed `Bought` in this browser: the conversion the server verifies.
      if (diagnostics.some((diagnostic) => diagnostic.event === "curve_conversion")) {
        reportCompletedBuy({
          outcome: { kind: "buy", launchId, txDigest: digest },
          accessToken: signingPrivySession(review.signer, signer()),
          report: reportOutcome,
          ...(privyTokenTimeoutMs === undefined ? {} : { privyTokenTimeoutMs }),
        });
      }
    });
  };
}

/**
 * The session's controllers: while either direction is unresolved
 * (`unresolvedTrade`), `submit`, `chooseSigner` and `approve` do nothing in
 * both directions, so no review opens, advances, or is signed until the lost
 * trade is reconciled by digest (`recheck`), whatever the markup offers.
 */
export function gateWhileUnresolved<Input = CurveTradeInput>(
  controllers: Readonly<Record<TradeDirection, ActionController<Input>>>,
): Readonly<Record<TradeDirection, ActionController<Input>>> {
  const open = () => unresolvedTrade<Input>({ buy: controllers.buy.getState(), sell: controllers.sell.getState() }) === null;
  const gate = (controller: ActionController<Input>): ActionController<Input> => ({
    ...controller,
    submit: (options) => void (open() && controller.submit(options)),
    chooseSigner: (kind) => void (open() && controller.chooseSigner(kind)),
    approve: (reviewId) => void (open() && controller.approve(reviewId)),
  });
  return { buy: gate(controllers.buy), sell: gate(controllers.sell) };
}
