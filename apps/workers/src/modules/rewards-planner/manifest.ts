import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { head, put } from "@vercel/blob";
import { buildRewardManifestPages, validateRewardManifestSummary, type RewardManifestPageStore } from "@interest-protocol/blast-core/rewards/allocations";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import { frozenSchema, json, PAGE_SIZE, readPlan } from "#workers/modules/reward-plan/plan.ts";
import { manifestReader } from "#workers/modules/reward-plan/manifest-store.ts";

export type ImmutableManifestStorage = {
  write(path: string, body: ReadableStream<Uint8Array>): Promise<{ url: string }>;
  read(url: string): Promise<ReadableStream<Uint8Array>>;
};
export function immutableBlobStorage(token: string): ImmutableManifestStorage {
  return {
    async write(path, body) {
      try { return await put(path, body, { token, access: "public", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json", cacheControlMaxAge: 31536000, abortSignal: AbortSignal.timeout(30000) }); }
      catch (error) { try { return await head(path, { token, abortSignal: AbortSignal.timeout(30000) }); } catch { throw error; } }
    },
    async read(url) {
      const result = await fetch(url, { signal: AbortSignal.timeout(30000), cache: "no-store" });
      if (!result.ok || !result.body) throw new Error("Immutable reward manifest is unavailable.");
      return result.body;
    },
  };
}

/** The planner's own store: the shared reads, plus the writes that store each hash and proof once. */
function manifestStore(pool: Pool, planId: string): RewardManifestPageStore {
  return {
    ...manifestReader(pool, planId),
    async writeHashes(level, offset, hashes) {
      await withTransaction(pool, async (tx) => {
        for (const [i, hash] of hashes.entries()) {
          await tx.forModule("rewards-planner").write("vault_reward_hashes", "INSERT INTO vault_reward_hashes(plan_id,level,position,hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [planId, level, offset + i, hash]);
          const exact = await tx.read("SELECT hash FROM vault_reward_hashes WHERE plan_id=$1 AND level=$2 AND position=$3 AND hash=$4", [planId, level, offset + i, hash]);
          if (exact.rowCount !== 1) throw new Error("Immutable reward hash differs from its stored position.");
        }
      });
    },
    async writeProofs(offset, proofs) {
      await withTransaction(pool, async (tx) => {
        for (const [i, proof] of proofs.entries()) {
          const exact = await tx.forModule("rewards-planner").write("vault_reward_allocations", `UPDATE vault_reward_allocations SET proof=$3
            WHERE plan_id=$1 AND leaf_index=$2 AND beneficiary=$4 AND meme_amount=$5 AND quote_amount=$6 AND (proof IS NULL OR proof=$3::jsonb) RETURNING leaf_index`, [planId, offset + i, json(proof), proof.beneficiary, proof.memeAmount, proof.quoteAmount]);
          if (exact.rowCount !== 1) throw new Error("Immutable reward proof differs from its allocation.");
        }
      });
    },
  };
}

export async function buildManifest(pool: Pool, planId: string): Promise<void> {
  const plan = await readPlan(pool, planId);
  if (plan.stage !== "proofs") throw new Error("Reward plan has not completed allocation.");
  const f = frozenSchema.parse(plan.inputs);
  const count = await withTransaction(pool, async (tx) => Number((await tx.read<{ count: string }>("SELECT count(*)::text AS count FROM vault_reward_allocations WHERE plan_id=$1", [planId])).rows[0]!.count));
  const manifest = await buildRewardManifestPages({ vaultId: f.vaultId, number: BigInt(f.number), startCheckpoint: BigInt(f.roundStart), endCheckpoint: BigInt(f.end.checkpoint), leafCount: count, pageSize: PAGE_SIZE }, manifestStore(pool, planId));
  await withTransaction(pool, async (tx) => {
    const exact = await tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET manifest=$2 WHERE plan_id=$1 AND stage='proofs' AND (manifest IS NULL OR manifest=$2::jsonb) RETURNING plan_id", [planId, json(manifest)]);
    if (exact.rowCount !== 1) throw new Error("Reward manifest changed during construction.");
  });
}

export async function uploadManifest(pool: Pool, planId: string, storage: ImmutableManifestStorage): Promise<void> {
  const plan = await readPlan(pool, planId), f = frozenSchema.parse(plan.inputs);
  if (plan.stage !== "proofs" && plan.stage !== "uploaded") throw new Error("Reward manifest is not ready to upload.");
  const manifest = validateRewardManifestSummary(plan.manifest as Parameters<typeof validateRewardManifestSummary>[0]);
  const store = manifestStore(pool, planId), encoder = new TextEncoder();
  async function* chunks() {
    yield encoder.encode(`${json({ ...manifest, leafDomain: "blast-holder-rewards-v2", accounting: f }).slice(0, -1)},"allocations":[`);
    let emitted = 0;
    for (let offset = 0; offset < manifest.leafCount; offset += PAGE_SIZE) {
      const count = Math.min(PAGE_SIZE, manifest.leafCount - offset), proofs = await store.readProofs(offset, count);
      if (proofs.length !== count) throw new Error("Reward manifest proof page is incomplete.");
      for (const proof of proofs) yield encoder.encode(`${emitted++ ? "," : ""}${json(proof)}`);
    }
    yield encoder.encode("]}");
  }
  let length = 0;
  const expected = createHash("sha256");
  for await (const part of chunks()) { expected.update(part); length += part.length; }
  const hash = expected.digest("hex");
  const { url } = await storage.write(`vault-holder-rewards-v2/${hash}.json`, Readable.toWeb(Readable.from(chunks())) as ReadableStream<Uint8Array>);
  const reader = (await storage.read(url)).getReader(), actual = createHash("sha256");
  let actualLength = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      actualLength += part.value.length;
      if (actualLength > length) throw new Error("Reward manifest exceeds its committed length.");
      actual.update(part.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  if (actualLength !== length || actual.digest("hex") !== hash) throw new Error("Reward manifest storage hash mismatch.");
  await withTransaction(pool, async (tx) => {
    const exact = await tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET stage='uploaded',storage_url=$2,storage_hash=$3,storage_verified_at=now() WHERE plan_id=$1 AND stage IN ('proofs','uploaded') AND manifest=$4::jsonb RETURNING plan_id", [planId, url, hash, json(plan.manifest)]);
    if (exact.rowCount !== 1) throw new Error("Reward plan changed during manifest upload.");
  });
}
