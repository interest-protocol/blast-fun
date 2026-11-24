import type { PrivateRouteContract } from "@blast/core/modules/backend-api/private-routes.ts";
import { SOCIAL_ERROR_MESSAGES } from "@blast/core/modules/social/contracts/errors.ts";
import {
  SOCIAL_TRADE_QUOTE_BUSY_RETRY_SECONDS,
  SOCIAL_TRADE_QUOTE_WORKERS,
} from "@blast/core/modules/social/contracts/trades.ts";
import { observeAdmission, type PrivateResourceLane } from "./metrics.ts";
import { refusal } from "./responses.ts";

export function createPrivateAdmission(ordinaryCapacity: number) {
  const privateLanes = new Map<string, number>();
  let expensiveInflight = 0;
  // At most half ordinary admission (and never over eight) on larger replicas.
  // Minimal replicas retain the existing two-upload concurrency contract.
  const maxExpensiveInflight = Math.min(8, Math.max(2, Math.floor(ordinaryCapacity / 2)));
  // Trading's lanes reserve their capacity inside that bound: other expensive
  // work is admitted only while every trading lane's unused permits stay free.
  // At least two permits remain for other work (the minimal two-upload
  // contract), so a small replica reserves less, one permit per lane in turn:
  // quotes and trades each keep one before either keeps a second.
  const tradingReserve = new Map<PrivateResourceLane, number>();
  let reservable = Math.max(0, maxExpensiveInflight - 2);
  const rounds = Math.max(...TRADING_LANES.map(([, , reserve]) => reserve));
  for (let round = 1; round <= rounds && reservable > 0; round++) {
    for (const [name, , reserve] of TRADING_LANES) {
      if (reserve >= round && reservable > 0) {
        tradingReserve.set(name, round);
        reservable--;
      }
    }
  }

  return reservePrivateLane;

  function reservePrivateLane(route: PrivateRouteContract): (() => void) | undefined {
    const lane = privateResourceLane(route);
    if (!lane) {
      return;
    }
    const [name, maximum] = lane;
    const count = privateLanes.get(name) ?? 0;
    const work = route.id === "social.trades.quote" ? "quote" : "other";
    if (
      count >= maximum ||
      expensiveInflight + unusedTradingReserve(name) >= maxExpensiveInflight
    ) {
      observeAdmission(name, "busy", {
        work,
        cause: count >= maximum ? "lane" : "aggregate",
      });
      throw route.id === "social.trades.quote"
        ? refusal(
            503,
            "quote_busy",
            SOCIAL_TRADE_QUOTE_BUSY_RETRY_SECONDS,
            SOCIAL_ERROR_MESSAGES.quote_busy,
          )
        : refusal(503, "busy");
    }
    privateLanes.set(name, count + 1);
    expensiveInflight++;
    observeAdmission(name, "admitted", { work });
    return () => {
      privateLanes.set(name, privateLanes.get(name)! - 1);
      expensiveInflight--;
    };
  }

  /** Reserved permits that trading lanes other than `lane` have not taken. */
  function unusedTradingReserve(lane: PrivateResourceLane): number {
    let unused = 0;
    for (const [name, share] of tradingReserve) {
      if (name !== lane) {
        unused += Math.max(0, share - (privateLanes.get(name) ?? 0));
      }
    }
    return unused;
  }
}

/**
 * Trading's lanes: [lane, permits, of which reserved]. Quotes run on the
 * executor's warm workers and as many more wait briefly for one
 * (`quote-executor.ts`), so the quote lane is twice the workers, the running
 * ones reserved. Trade submissions keep their four permits, two reserved.
 * Neither waits behind slow provider reads, uploads or renders.
 */
const TRADING_LANES = [
  ["quote", 2 * SOCIAL_TRADE_QUOTE_WORKERS, SOCIAL_TRADE_QUOTE_WORKERS],
  ["trade", 4, 2],
] as const satisfies readonly (readonly [PrivateResourceLane, number, number])[];

function privateResourceLane(
  route: PrivateRouteContract,
): readonly [PrivateResourceLane, number] | undefined {
  if (route.id === "social.trades.quote") {
    return [TRADING_LANES[0][0], TRADING_LANES[0][1]];
  }
  if (route.id === "social.trades.create") {
    return [TRADING_LANES[1][0], TRADING_LANES[1][1]];
  }
  switch (route.resourceClass) {
    case "upload":
      return ["upload", 2];
    case "render":
      return ["render", 2];
    case "bulk":
      if (route.id === "presale.allowlists.create") {
        return ["allowlist", 1];
      }
      return ["long-work", 4];
    case "provider-heavy":
      return ["long-work", 4];
  }
}
