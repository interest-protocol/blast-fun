// What to do next after a refusal or a failure: retry, refresh the curve,
// adjust the amount, trade on another route, or stop. The input is always
// kept; nothing is signed or submitted again on its own.

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import type { ActionState } from "../transaction/action-machine.ts";
import { curveAbortOf } from "./aborts.ts";
import type { CurveTradeInput } from "./curve-adapter.ts";

export type GuidanceAction = "retry" | "refresh" | "adjust" | "route" | "stop" | "wait";

export type Guidance = Readonly<{ action: GuidanceAction; text: string }>;

const SLIPPAGE: Guidance = {
  action: "refresh",
  text: "The price moved past your slippage tolerance before the trade executed. Nothing changed hands. Review again at the new price, or allow more slippage.",
};

function fromAbort(message: string, deployment: BlastDeployment | null): Guidance | null {
  switch (curveAbortOf(message, deployment)) {
    case "slippage":
      return SLIPPAGE;
    case "lifecycle":
      return { action: "stop", text: "The curve is no longer trading, so this trade cannot run here." };
    case "zero-output":
      return { action: "adjust", text: "This amount returns nothing after fees. Enter a larger amount." };
    default:
      return null;
  }
}

/** `deployment` is the accepted deployment, whose launchpad package an abort must come from to be read. */
export function tradeGuidance(state: ActionState<CurveTradeInput>, deployment: BlastDeployment | null): Guidance | null {
  switch (state.phase) {
    case "blocked": {
      const { block } = state;
      switch (block.code) {
        case "insufficient-balance":
        case "ineligible":
        case "preview-unavailable":
          return { action: "adjust", text: "Change the amount, then review again." };
        case "stale-lifecycle":
          return { action: "stop", text: "The curve is not trading now. Nothing was signed." };
        case "stale-route":
          return { action: "route", text: "This coin trades on its venue pool now, not on the curve." };
        case "simulation-failed":
          return fromAbort(block.message, deployment) ?? { action: "refresh", text: "Sui refused this trade in simulation. Refresh and review again." };
        case "wrong-network":
          return { action: "retry", text: "Switch your wallet to the network shown, then review again." };
        default:
          return { action: "retry", text: "Nothing was signed. Try the review again in a moment." };
      }
    }
    case "failed":
      return state.stage === "signature"
        ? { action: "retry", text: "The wallet could not sign. Nothing was submitted; review again when ready." }
        : (fromAbort(state.message, deployment) ?? { action: "refresh", text: "The trade failed on chain and nothing changed hands. Refresh, then review again." });
    case "rejected":
      return { action: "retry", text: "You declined the signature. Nothing was submitted; your amount is kept." };
    case "ambiguous":
      return { action: "wait", text: "Sui has not confirmed this trade yet. Do not trade again until it is resolved: reconcile it by its transaction first." };
    default:
      return null;
  }
}
