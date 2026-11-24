import { z } from "zod";
import { deriveLaunchEconomics, MEME_TOTAL_SUPPLY_WHOLE_TOKENS } from "@interest-protocol/blast-sdk/launchpad";
import { parseAllocationPlan, parseFeeSplit, parsePoolStats } from "@blast/core/modules/launchpad-contract/coin.ts";
import { ContractViolation } from "@blast/core/modules/launchpad-contract/decimal.ts";
import { launchProgressBps, parseLaunchSummary } from "@blast/core/modules/launchpad-contract/discovery.ts";
import type { RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { sectionFromRead, type Section } from "@blast/core/modules/launchpad-contract/section.ts";
import type { V1Answer } from "@blast/core/modules/launchpad-contract/v1.ts";
import type { CurveRead } from "./contracts.ts";
export type { CoinPage } from "./contracts.ts";
function record(value: unknown, field: string): Record<string, unknown> {
  if (!z.record(z.string(), z.unknown()).safeParse(value).success) {
    throw new ContractViolation(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

/** The SDK's value of `derive`, or null when the SDK refuses these inputs. */
function derived<T>(derive: () => T): T | null {
  try {
    return derive();
  } catch {
    return null;
  }
}

/** `GET /v1/pools/blast_curve/{launch_id}`: the launch's curve, which must be that launch. */
export function parseCurveBody(body: unknown, launchId: string): CurveRead {
  const pool = record(record(body, "body").pool, "pool");
  const launch = parseLaunchSummary(pool, "pool");
  if (launch.launchId !== launchId) throw new ContractViolation("pool.pool_id", "must be the requested launch");
  const plan = parseAllocationPlan(launch.launch.allocationPlan, "pool.launch.allocation_plan");
  const split = parseFeeSplit(launch.launch.lpFeeSplit, "pool.launch.lp_fee_split");
  const { virtualQuote, graduationTarget, memeDecimals } = launch.economics.inputs;
  return {
    launch,
    stats: parsePoolStats(pool, "pool"),
    plan,
    split,
    // Without either curve input there are no starting economics; the SDK refuses impossible ones.
    economics:
      virtualQuote === null || graduationTarget === null
        ? null
        : derived(() =>
            deriveLaunchEconomics({
              atomicSupply: MEME_TOTAL_SUPPLY_WHOLE_TOKENS * 10n ** memeDecimals,
              allocationPlan: plan,
              virtualQuote,
              graduationTarget,
            })),
    progressBps: derived(() => launchProgressBps(launch)),
  };
}

/** A `/v1` answer as a section: a refusal is Unavailable with blast-infra's code. */
export function answerSection<T>(read: RoutedRead<V1Answer<T>>): Section<T> {
  if (read.status !== "unavailable" && read.data.kind === "refused") {
    return { state: "unavailable", reason: read.data.error.code, provenance: read.provenance };
  }
  const value = read.status === "unavailable" ? read : { ...read, data: (read.data as { value: T }).value };
  return sectionFromRead(value, () => false);
}
