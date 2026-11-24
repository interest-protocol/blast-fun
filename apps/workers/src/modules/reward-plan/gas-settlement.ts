import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { MissingRewardHistory } from "./evidence.ts";
import { assertPrice, type Price } from "./prices.ts";

/** A USD price as stored with each gas effect: an exact positive rational. */
export const rationalSchema = z.object({ numerator: z.string().regex(/^[1-9][0-9]*$/), denominator: z.string().regex(/^[1-9][0-9]*$/) });

type GasCost = Readonly<{
  digest: string;
  netSuiAtoms: bigint;
  suiUsd: Price;
  quoteUsd: Price;
}>;

/** Sorted SQL pages need only one prior digest and one exact rational accumulator. */
export function reimbursementAccumulator(reserve: bigint) {
  if (reserve < 0n) throw new Error("Invalid gas reserve.");
  let numerator = 0n,
    denominator = 1n,
    previous: string | null = null;
  return {
    add(effect: GasCost): void {
      if (
        !z
          .string()
          .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)
          .safeParse(effect.digest).success
      )
        throw new Error("Invalid finalized gas digest.");
      if (previous !== null && effect.digest <= previous)
        throw new Error("Duplicate or unordered finalized gas digest.");
      previous = effect.digest;
      assertPrice(effect.suiUsd);
      assertPrice(effect.quoteUsd);
      const n = effect.netSuiAtoms * effect.suiUsd.numerator * effect.quoteUsd.denominator;
      const d = effect.suiUsd.denominator * effect.quoteUsd.numerator;
      numerator = numerator * d + n * denominator;
      denominator *= d;
      let a = numerator < 0n ? -numerator : numerator,
        b = denominator;
      while (b !== 0n) [a, b] = [b, a % b];
      numerator /= a;
      denominator /= a;
    },
    amount(): bigint {
      const actual = numerator > 0n ? numerator / denominator : 0n;
      return actual < reserve ? actual : reserve;
    },
  };
}

/** Signed execution costs are summed exactly, then floored and capped once. */
export async function settlementEvidence(pool: Pool, planId: string, reserve: bigint) {
  return withTransaction(pool, async (tx) => {
    const missing = await tx.read(`SELECT a.action_id FROM vault_reward_actions a LEFT JOIN vault_reward_gas_effects g USING(digest)
      WHERE a.plan_id=$1 AND a.kind IN ('schedule_round','publish_round','claim') AND (a.state IN ('signing','signed','ready') OR (a.state IN ('executed','failed') AND g.digest IS NULL)) LIMIT 1`, [planId]);
    if (missing.rowCount) throw new MissingRewardHistory("incomplete-gas-costs");
    const accumulator = reimbursementAccumulator(reserve), hash = createHash("sha256");
    let after = "", count = 0;
    for (;;) {
      const { rows } = await tx.read<{ digest: string; net_sui_atoms: string; sui_usd: unknown; quote_usd: unknown }>("SELECT digest,net_sui_atoms::text,sui_usd,quote_usd FROM vault_reward_gas_effects WHERE plan_id=$1 AND digest>$2 ORDER BY digest LIMIT 512", [planId, after]);
      for (const row of rows) {
        const sui = rationalSchema.parse(row.sui_usd), quote = rationalSchema.parse(row.quote_usd);
        accumulator.add({ digest: row.digest, netSuiAtoms: BigInt(row.net_sui_atoms), suiUsd: { numerator: BigInt(sui.numerator), denominator: BigInt(sui.denominator) }, quoteUsd: { numerator: BigInt(quote.numerator), denominator: BigInt(quote.denominator) } });
        hash.update(`${row.digest}\n`); count++; after = row.digest;
      }
      if (rows.length < 512) break;
    }
    if (count === 0) throw new MissingRewardHistory("empty-gas-costs");
    return { reimbursement: accumulator.amount().toString(), gasEffectsHash: hash.digest("hex"), gasEffectCount: count };
  }, { isolationLevel: "REPEATABLE READ" });
}
