import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { Item, Snapshot } from "./contracts.ts";

const feeMetrics = ["fees", "revenue", "protocol_revenue", "supply_side_revenue"] as const;
const launchpadSources = new Set(["creation", "curve_swaps", "migration", "presale_raise"]);
// DeFiLlama's Sui core asset uses the short form for native SUI.
const nativeSuiToken = "sui:0x2::sui::SUI";

type Breakdown = Record<string, Record<string, string>>;
export type DailyFees = {
  dailyFees: Breakdown;
  dailyRevenue: Breakdown;
  dailySupplySideRevenue: Breakdown;
};

export function sumFeeSummaries(summaries: readonly DailyFees[]): DailyFees {
  const total: DailyFees = {
    dailyFees: {},
    dailyRevenue: {},
    dailySupplySideRevenue: {},
  };
  for (const summary of summaries) {
    for (const metric of ["dailyFees", "dailyRevenue", "dailySupplySideRevenue"] as const) {
      for (const [source, coins] of Object.entries(summary[metric])) {
        const balances = (total[metric][source] ??= {});
        for (const [coin, amount] of Object.entries(coins)) {
          balances[coin] = (BigInt(balances[coin] ?? "0") + BigInt(amount)).toString();
        }
      }
    }
  }
  return total;
}

export function summarizeDailyFees(snapshot: Snapshot): DailyFees | undefined {
  const { launchpad, frontend_router: frontend } = snapshot.scope_coverage;
  if (
    snapshot.frontend_fee_coverage.status !== "complete" ||
    feeMetrics.some(
      (metric) => launchpad[metric].status !== "complete" || frontend[metric].status !== "complete",
    )
  ) {
    return;
  }

  const daily: DailyFees = { dailyFees: {}, dailyRevenue: {}, dailySupplySideRevenue: {} };
  const seen = new Set<string>();
  for (const item of snapshot.items) {
    if (!item.included_in_totals || item.underlying_venue_overlap) {
      continue;
    }

    const coin = normalizeStructTag(item.coin_type);
    const token = coin === SUI_COIN_TYPE ? nativeSuiToken : `sui:${coin}`;
    const key = `${item.component}:${token}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate DeFiLlama fee row: ${key}`);
    }
    seen.add(key);

    recordFeeItem(daily, item, token);
  }
  return daily;
}

function recordFeeItem(daily: DailyFees, { component, metrics, evidence }: Item, token: string) {
  const fees = atoms(metrics.fees);
  const revenue = atoms(metrics.revenue);
  const supply = atoms(metrics.supply_side_revenue);
  if (atoms(metrics.protocol_revenue) !== revenue || fees !== revenue + supply) {
    throw new Error(`Unreconciled DeFiLlama fee allocation: ${component}`);
  }

  if (component === "frontend_router_fees") {
    const cetus = atoms(evidence.cetus_paid ?? "0");
    const aftermath = atoms(evidence.aftermath_paid ?? "0");
    if (cetus + aftermath !== fees || revenue !== fees) {
      throw new Error("Unreconciled DeFiLlama frontend fees");
    }
    recordFees(daily, "cetus", token, { fees: cetus, revenue: cetus, supply: 0n });
    recordFees(daily, "aftermath", token, { fees: aftermath, revenue: aftermath, supply: 0n });
    return;
  }
  if (!launchpadSources.has(component)) {
    throw new Error(`Unrecognized DeFiLlama fee source: ${component}`);
  }
  recordFees(daily, component, token, { fees, revenue, supply });
}

function atoms(value: string | null): bigint {
  if (value === null || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid DeFiLlama fee amount");
  }
  return BigInt(value);
}

function recordFees(
  daily: DailyFees,
  source: string,
  token: string,
  { fees, revenue, supply }: { fees: bigint; revenue: bigint; supply: bigint },
) {
  if (fees > 0n) {
    (daily.dailyFees[source] ??= {})[token] = fees.toString();
  }
  if (revenue > 0n) {
    (daily.dailyRevenue[source] ??= {})[token] = revenue.toString();
  }
  if (supply > 0n) {
    (daily.dailySupplySideRevenue[source] ??= {})[token] = supply.toString();
  }
}
