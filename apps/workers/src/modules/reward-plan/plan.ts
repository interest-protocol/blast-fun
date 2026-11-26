import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { hashSchema, objectIdSchema, u64Schema, canonicalCoinSchema } from "#workers/lib/validation.ts";

export const PAGE_SIZE = 512;
export const CLAIM_WINDOW_MS = 7 * 86_400_000;
const cutSchema = z.object({ checkpoint: u64Schema, digest: z.string().min(32).max(44), timestampMs: u64Schema });
export type Cut = z.infer<typeof cutSchema>;
const priceSchema = z.object({ numerator: z.string().regex(/^[1-9][0-9]*$/), denominator: z.string().regex(/^[1-9][0-9]*$/), evidence: z.record(z.string(), z.unknown()) });
export const frozenSchema = z.object({
  network: z.literal("mainnet"), fingerprint: hashSchema, vaultId: objectIdSchema,
  memeType: canonicalCoinSchema, quoteType: canonicalCoinSchema, poolId: objectIdSchema,
  originId: objectIdSchema, number: u64Schema, startMs: u64Schema, endMs: u64Schema,
  start: cutSchema, end: cutSchema, roundStart: u64Schema,
  exclusions: z.array(objectIdSchema).max(10000), treasury: objectIdSchema,
  memePrice: priceSchema.nullable(), quotePrice: priceSchema.nullable(),
  grossMeme: u64Schema, grossQuote: u64Schema, reserve: u64Schema,
  gasReserveBps: z.number().int().min(0).max(909), claimWindowMs: z.literal(CLAIM_WINDOW_MS),
  globalWeight: z.string().regex(/^[0-9]+$/), qualifiers: z.number().int().min(0),
  sourceEvidence: z.record(z.string(), z.unknown()),
  // Published plans from earlier policies must retain their original commitment.
  payoutPolicy: z.enum(["both-assets-to-holders", "combined-value-to-holders", "no-minimum"]).optional(),
});
export type Frozen = z.infer<typeof frozenSchema>;

export function hasHolderAllocation(policy: Frozen["payoutPolicy"], memeAmount: string, quoteAmount: string): boolean {
  return quoteAmount !== "0" || (policy === "no-minimum" && memeAmount !== "0");
}

export type Plan = {
  plan_id: string; period_id: string; number: string; stage: string; inputs: unknown;
  manifest: unknown; storage_url: string | null; storage_hash: string | null;
  storage_verified_at: Date | null;
};
export function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

/** The hash a reserved plan stores as `commitment`: its frozen inputs, manifest and stored upload, exactly. */
export function planCommitment(inputs: Frozen, manifest: unknown, storageHash: string | null): string {
  const canonical = json({ inputs, manifest, storageHash });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function readPlan(pool: Pool, id: string): Promise<Plan> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.read<Plan>("SELECT * FROM vault_reward_plans WHERE plan_id=$1", [id]);
    if (!rows[0]) throw new Error("Reward plan is unavailable.");
    return rows[0];
  });
}
