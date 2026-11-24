// The venue rail's session rules over both directions' controllers, as pure
// functions: T-004's ambiguity rule (nothing new starts while a trade is
// unresolved, `gateWhileUnresolved`) and quote expiry. A review whose quote has
// expired is never approved: approving it reads Sui and quotes again, and the
// new review needs its own confirmation. Failures are told in words: a Move
// abort is never shown raw, and Bluefin's `slippage_exceeds` (read only from
// the deployment's Bluefin Spot package) says the pool moved past the minimum.

import type { BlastDeployment } from "@interest-protocol/blast-sdk/deployments";

import { abortIn } from "../launch/advanced/contract-errors.ts";
import type { ActionState } from "../transaction/action-machine.ts";
import type { ActionController } from "../transaction/controller.ts";
import type { TradeDirection } from "./curve-adapter.ts";

import { gateWhileUnresolved } from "./curve-trade-provider-model.ts";

type Controllers<Input> = Readonly<Record<TradeDirection, ActionController<Input>>>;

/** Whether `state` is a review whose quote can no longer be signed at `nowMs`. */
export function reviewExpired<Input>(state: ActionState<Input>, nowMs: number): boolean {
  return state.phase === "review" && state.review.expiresAtMs != null && nowMs >= state.review.expiresAtMs;
}

/** `controllers` gated while a trade is unresolved, with `approve` of an expired review replaced by a fresh review. */
export function gateVenueTrades<Input>(controllers: Controllers<Input>, now: () => number = Date.now): Controllers<Input> {
  const gated = gateWhileUnresolved<Input>(controllers);
  const expiring = (direction: TradeDirection): ActionController<Input> => ({
    ...gated[direction],
    approve(reviewId) {
      if (!reviewExpired(controllers[direction].getState(), now())) return gated[direction].approve(reviewId);
      gated[direction].cancel();
      gated[direction].submit();
    },
  });
  return { buy: expiring("buy"), sell: expiring("sell") };
}

export type VenueGuidance = Readonly<{ action: "retry" | "refresh" | "adjust" | "stop" | "wait"; text: string }>;

/**
 * Bluefin Spot `errors::slippage_exceeds()` (interface 91ce930): `pool::swap`
 * would pay less than its `amount_limit`, which the SDK sets to the quote's
 * minimum output.
 */
const BLUEFIN_SLIPPAGE_EXCEEDS = 1010;

type VenueAbort = "bluefin-slippage" | "other";

/** What a Move abort in `message` means for a venue swap; null when the message reports no abort. */
function venueAbortOf(message: string, deployment: BlastDeployment | null): VenueAbort | null {
  if (!/MoveAbort|abort code/i.test(message)) return null;
  const bluefin = deployment ? abortIn(message, deployment.packages.bluefinSpot) : null;
  return bluefin?.code === BLUEFIN_SLIPPAGE_EXCEEDS ? "bluefin-slippage" : "other";
}

const BLUEFIN_SLIPPAGE = (outcome: string) =>
  `The Bluefin pool moved past your slippage tolerance ${outcome} Review again for a fresh quote, or allow more slippage.`;

/**
 * The refusal or failure to show for `state`, in words: a Move abort is never
 * shown raw. Messages without an abort are shown as they are; null when there
 * is nothing to report.
 */
export function venueProblem<Input>(state: ActionState<Input>, deployment: BlastDeployment | null): string | null {
  switch (state.phase) {
    case "blocked":
      switch (venueAbortOf(state.block.message, deployment)) {
        case "bluefin-slippage":
          return "Sui refused this swap in simulation: the Bluefin pool would pay less than the fewest you accept. Nothing was signed.";
        case "other":
          return "Sui refused this swap in simulation. Nothing was signed.";
        default:
          return state.block.message;
      }
    case "failed":
      switch (venueAbortOf(state.message, deployment)) {
        case "bluefin-slippage":
          return "The swap failed on Sui: the Bluefin pool paid less than the fewest you accept, so it was reverted. Only network fees were spent.";
        case "other":
          return "The swap failed on Sui and was reverted. Only network fees were spent.";
        default:
          return state.message;
      }
    case "ambiguous":
      return state.message;
    default:
      return null;
  }
}

/**
 * What to do next after a venue refusal or failure. The input is always kept;
 * nothing signs again on its own. `deployment` is the accepted deployment,
 * whose Bluefin Spot package an abort must come from to be read as Bluefin's.
 */
export function venueGuidance<Input>(state: ActionState<Input>, deployment: BlastDeployment | null): VenueGuidance | null {
  switch (state.phase) {
    case "blocked":
      switch (state.block.code) {
        case "insufficient-balance":
        case "ineligible":
        case "preview-unavailable":
          return { action: "adjust", text: "Change the amount, then review again." };
        case "stale-route":
        case "stale-lifecycle":
          return { action: "stop", text: "Nothing can be signed on this route. The launch's pool, curve history and migration stay readable here." };
        case "simulation-failed":
          return venueAbortOf(state.block.message, deployment) === "bluefin-slippage"
            ? { action: "refresh", text: BLUEFIN_SLIPPAGE("after the quote, so it would pay less than the fewest you accept. Nothing was signed.") }
            : { action: "refresh", text: "Sui refused this swap in simulation, so nothing was signed. Review again for a fresh quote." };
        case "wrong-network":
          return { action: "retry", text: "Switch your wallet to the network shown, then review again." };
        default:
          return { action: "retry", text: "Nothing was signed. Try the review again in a moment." };
      }
    case "failed":
      if (state.stage === "signature") return { action: "retry", text: "The wallet could not sign. Nothing was submitted; review again when ready." };
      return venueAbortOf(state.message, deployment) === "bluefin-slippage"
        ? { action: "refresh", text: BLUEFIN_SLIPPAGE("before the swap executed, so it paid less than the fewest you accept. Nothing changed hands.") }
        : { action: "refresh", text: "The swap failed on chain and nothing changed hands; the pool may have moved past your minimum. Review again for a fresh quote." };
    case "rejected":
      return { action: "retry", text: "You declined the signature. Nothing was submitted; your amount is kept." };
    case "ambiguous":
      return { action: "wait", text: "Sui has not confirmed this swap yet. Do not trade again until it is resolved: reconcile it by its transaction first." };
    default:
      return null;
  }
}
