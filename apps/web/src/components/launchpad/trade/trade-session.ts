import type { CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import type { ActionState } from "../transaction/action-machine.ts";
import { isMigratorVenue } from "@blast/core/modules/launchpad-contract/venues.ts";

export type TradeTarget = Readonly<{
  kind: "curve" | "venue";
  poolKey: string;
}>;
export function tradeTarget(
  availability: CoinPage["availability"],
  launchId: string,
): TradeTarget | null {
  if (availability.kind === "curve")
    return { kind: "curve", poolKey: `blast_curve:${launchId}` };
  if (availability.kind === "venue" && isMigratorVenue(availability.route.venue))
    return { kind: "venue", poolKey: availability.poolKey };
  return null;
}
export function targetKey(target: TradeTarget | null): string | null {
  return target ? `${target.kind}:${target.poolKey}` : null;
}

/** Keep preflight and all signed work alive until its transaction is settled. */
export function sessionHeld<Input>(
  buy: ActionState<Input>,
  sell: ActionState<Input>,
): boolean {
  const held = new Set(["preflighting", "signing", "reconciling", "ambiguous"]);
  return held.has(buy.phase) || held.has(sell.phase);
}
