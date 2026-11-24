import type { Pool } from "pg";
import type { RewardManifestPageStore, RewardProof } from "@interest-protocol/blast-core/rewards/allocations";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";

/** What both sides may read of a plan's manifest; only the planner writes it (`rewards-planner/manifest.ts`). */
export type ManifestReader = Pick<RewardManifestPageStore, "readAllocations" | "readHashes" | "readProofs">;

/** A plan's leaves and proof tree, page by page. */
export function manifestReader(pool: Pool, planId: string): ManifestReader {
  return {
    async readAllocations(offset, count) {
      return withTransaction(pool, async (tx) => {
        const { rows } = await tx.read<{ beneficiary: string; meme_amount: string; quote_amount: string }>("SELECT beneficiary,meme_amount::text,quote_amount::text FROM vault_reward_allocations WHERE plan_id=$1 AND leaf_index>=$2 AND leaf_index<$3 ORDER BY leaf_index", [planId, offset, offset + count]);
        return rows.map((r) => ({ beneficiary: r.beneficiary, memeAmount: BigInt(r.meme_amount), quoteAmount: BigInt(r.quote_amount) }));
      });
    },
    async readHashes(level, offset, count) {
      return withTransaction(pool, async (tx) => (await tx.read<{ hash: string }>("SELECT hash FROM vault_reward_hashes WHERE plan_id=$1 AND level=$2 AND position>=$3 AND position<$4 ORDER BY position", [planId, level, offset, offset + count])).rows.map((r) => r.hash));
    },
    async readProofs(offset, count) {
      return withTransaction(pool, async (tx) => {
        const { rows } = await tx.read<{ proof: RewardProof | null }>("SELECT proof FROM vault_reward_allocations WHERE plan_id=$1 AND leaf_index>=$2 AND leaf_index<$3 ORDER BY leaf_index", [planId, offset, offset + count]);
        return rows.flatMap((r) => r.proof ? [r.proof] : []);
      });
    },
  };
}
