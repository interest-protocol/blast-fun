import type { FeeSplit } from "@interest-protocol/blast-core/fee-split";
import type { VaultEventPayloads } from "@interest-protocol/blast-sdk/vault";

export type VaultIncome = {
  coin: string;
  gross: bigint;
  protocol: bigint;
  allocations: Record<string, bigint>;
};

const ALLOCATIONS = {
  Address: "recipients_paid",
  Owner: "owner_accrued",
  AutoLp: "auto_lp_allocated",
  HolderRewards: "launched_coin_holder_allocation",
  Burn: "burn_allocated",
} as const;

export function vaultIncome(
  p: VaultEventPayloads["FeesCollected"],
  meme: string,
  quote: string,
  split: FeeSplit,
): VaultIncome[] {
  return (["meme", "quote"] as const).map((asset) => {
    const amounts = p[`route_${asset}_amounts`];
    if (amounts.length !== split.routes.length) throw new Error("Vault fee split history does not reconcile");
    const allocations: Record<string, bigint> = {};
    for (const [index, route] of split.routes.entries()) {
      const key = ALLOCATIONS[route.destination.kind];
      allocations[key] = (allocations[key] ?? 0n) + amounts[index]!;
    }
    return {
      coin: asset === "meme" ? meme : quote,
      gross: p[`gross_${asset}_amount`],
      protocol: p[`protocol_${asset}_amount`],
      allocations,
    };
  });
}
