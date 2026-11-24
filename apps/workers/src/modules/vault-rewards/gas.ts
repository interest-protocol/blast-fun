import type { Pool } from "pg";
import type { SuiClientTypes } from "@mysten/sui/client";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { z } from "zod";
import { frozenSchema, json } from "#workers/modules/reward-plan/plan.ts";
import { MissingRewardHistory, requireRewardCut } from "#workers/modules/reward-plan/evidence.ts";
import { rationalSchema } from "#workers/modules/reward-plan/gas-settlement.ts";
import type { PricePolicy } from "#workers/modules/reward-plan/prices.ts";
import type { RewardAction } from "./custody.ts";
import { parseRewardIntent } from "./transactions.ts";

export async function recordGas(pool: Pool, action: RewardAction, run: SuiClientTypes.Transaction<{ effects: true }>, policy: PricePolicy): Promise<void> {
  const intent = parseRewardIntent(action.payload);
  if (!["schedule_round", "publish_round", "claim"].includes(intent.kind)) return;
  if (run.checkpoint === null || run.timestampMs === null || !run.effects || run.effects.transactionDigest !== action.digest) throw new MissingRewardHistory("finalized-gas-receipt");
  const gas = run.effects.gasUsed;
  const net = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
  await withTransaction(pool, async (tx) => {
    const { rows: plans } = await tx.read<{ inputs: unknown }>("SELECT inputs FROM vault_reward_plans WHERE plan_id=$1", [action.plan_id]);
    const f = frozenSchema.parse(plans[0]?.inputs);
    const { rows: headers } = await tx.read<{ digest: string }>("SELECT digest FROM chain_read_v1.checkpoint_headers WHERE checkpoint=$1", [run.checkpoint]);
    const digest = headers[0]?.digest;
    if (!digest) throw new MissingRewardHistory("gas-checkpoint");
    const cut = { checkpoint: String(run.checkpoint), digest, timestampMs: String(run.timestampMs) };
    await requireRewardCut(tx, f.fingerprint, cut);
    const prices = [];
    if (BigInt(f.reserve) > 0n) for (const coin of [`0x${"2".padStart(64, "0")}::sui::SUI`, f.quoteType]) {
      const { rows } = await tx.read<{ observation: unknown }>("SELECT chain_read_v1.usd_observation('mainnet',$1,$2,$3,$4,4294967295,4294967295,$5,$6,$7) AS observation", [f.fingerprint, coin, cut.checkpoint, cut.digest, cut.timestampMs, policy.maxAgeMs, policy.maxConfidenceBps]);
      const p = z.object({ available: z.literal(true), numerator: z.string(), denominator: z.string(), exponent: z.number().int().min(-255).max(255) }).parse(rows[0]?.observation);
      let n = BigInt(p.numerator), d = BigInt(p.denominator);
      if (p.exponent < 0) d *= 10n ** BigInt(-p.exponent); else n *= 10n ** BigInt(p.exponent);
      prices.push(rationalSchema.parse({ numerator: n.toString(), denominator: d.toString() }));
    }
    const values = [action.digest, action.plan_id, cut.checkpoint, cut.timestampMs, net.toString(), prices[0] ? json(prices[0]) : null, prices[1] ? json(prices[1]) : null];
    await tx.forModule("vault-rewards").write("vault_reward_gas_effects", "INSERT INTO vault_reward_gas_effects(digest,plan_id,checkpoint,timestamp_ms,net_sui_atoms,sui_usd,quote_usd) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", values);
    const exact = await tx.read("SELECT digest FROM vault_reward_gas_effects WHERE digest=$1 AND plan_id=$2 AND checkpoint=$3 AND timestamp_ms=$4 AND net_sui_atoms=$5 AND sui_usd IS NOT DISTINCT FROM $6::jsonb AND quote_usd IS NOT DISTINCT FROM $7::jsonb", values);
    if (exact.rowCount !== 1) throw new Error("Finalized reward gas evidence changed.");
  }, { isolationLevel: "REPEATABLE READ", retry: true });
}

