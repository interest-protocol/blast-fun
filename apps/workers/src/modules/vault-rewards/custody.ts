import { randomUUID } from "node:crypto";
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import type { Pool } from "pg";
import { withTransaction } from "@blast/core/modules/database/transaction.ts";
import type { SignedTransaction } from "#workers/modules/worker-runtime/signer.ts";
import { parseRewardIntent, type RewardIntent } from "./transactions.ts";
import { json } from "#workers/modules/reward-plan/plan.ts";

export type RewardAction = { action_id: string; plan_id: string; semantic_key: string; kind: string; state: string; payload: unknown; digest: string | null; transaction_bytes: Buffer | null; signature: string | null };

/** Every retry is another immutable journal row; a signed attempt is never overwritten. */
export async function rewardAction(pool: Pool, intent: RewardIntent, maxAttempts: number): Promise<RewardAction | null> {
  return withTransaction(pool, async (tx) => {
    await tx.read("SELECT plan_id FROM vault_reward_plans WHERE plan_id=$1 FOR UPDATE", [intent.planId]);
    const { rows } = await tx.read<RewardAction>("SELECT * FROM vault_reward_actions WHERE plan_id=$1 AND payload->>'operation'=$2 ORDER BY created_at,action_id", [intent.planId, intent.operation]);
    if (rows.some((r) => r.state === "executed")) return null;
    const active = rows.find((r) => ["ready", "signing", "signed"].includes(r.state));
    if (active) {
      // An unsigned draft may refresh an owned cap's version after another plan used it.
      // Prepared bytes never enter this branch and retain their original payload forever.
      if (active.state === "ready" && json(parseRewardIntent(active.payload)) !== json(intent)) {
        await tx.forModule("vault-rewards").write("vault_reward_actions", "UPDATE vault_reward_actions SET payload=$2 WHERE action_id=$1 AND state='ready' AND transaction_bytes IS NULL", [active.action_id, json(intent)]);
        return { ...active, payload: intent };
      }
      return active;
    }
    if (rows.length >= maxAttempts) throw new Error("Vault rewards action exhausted its attempt limit.");
    const id = randomUUID(), key = `${intent.operation}:${rows.length}`;
    await tx.forModule("vault-rewards").write("vault_reward_actions", "INSERT INTO vault_reward_actions(action_id,plan_id,semantic_key,kind,state,payload) VALUES($1,$2,$3,$4,'ready',$5)", [id, intent.planId, key, intent.kind, json(intent)]);
    return { action_id: id, plan_id: intent.planId, semantic_key: key, kind: intent.kind, state: "ready", payload: intent, digest: null, transaction_bytes: null, signature: null };
  }, { isolationLevel: "READ COMMITTED", retry: true });
}

/** The database commitment precedes the crypto signature. Other attempts of the plan remain fenced. */
export async function reserveRewardBytes(pool: Pool, action: RewardAction, bytes: Uint8Array): Promise<void> {
  const intent = parseRewardIntent(action.payload), txData = Transaction.from(bytes).getData();
  if (txData.expiration?.$kind !== "ValidDuring" || txData.gasData.payment?.length !== 0) throw new Error("Reward custody requires bounded address-balance bytes.");
  const owned = txData.inputs.filter((i) => i.Object?.ImmOrOwnedObject || i.Object?.Receiving);
  if (owned.length !== ("admin" in intent ? 1 : 0) || owned.some((i) => i.Object?.Receiving || i.Object?.ImmOrOwnedObject?.objectId !== ("admin" in intent ? intent.admin.objectId : null))) throw new Error("Unexpected owned reward input.");
  await withTransaction(pool, async (tx) => {
    await tx.read("SELECT plan_id FROM vault_reward_plans WHERE plan_id=$1 FOR UPDATE", [action.plan_id]);
    if ("admin" in intent) await tx.read("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`vault-rewards-cap:${intent.admin.objectId}`]);
    const pending = await tx.read("SELECT action_id FROM vault_reward_actions WHERE (plan_id=$1 OR ($3::text IS NOT NULL AND payload->'admin'->>'objectId'=$3)) AND action_id<>$2 AND state IN ('signing','signed') LIMIT 1", [action.plan_id, action.action_id, "admin" in intent ? intent.admin.objectId : null]);
    if (pending.rowCount) throw new Error("Another reward transaction may still execute.");
    const updated = await tx.forModule("vault-rewards").write("vault_reward_actions", "UPDATE vault_reward_actions SET state='signing',digest=$2,transaction_bytes=$3 WHERE action_id=$1 AND state='ready' AND payload=$4::jsonb RETURNING action_id", [action.action_id, TransactionDataBuilder.getDigestFromBytes(bytes), Buffer.from(bytes), json(intent)]);
    if (updated.rowCount !== 1) throw new Error("Reward signing action is stale.");
  });
}

export async function assertRewardBytes(pool: Pool, actionId: string, bytes: Uint8Array): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const result = await tx.read("SELECT action_id FROM vault_reward_actions WHERE action_id=$1 AND state='signing' AND transaction_bytes=$2 AND digest=$3", [actionId, Buffer.from(bytes), TransactionDataBuilder.getDigestFromBytes(bytes)]);
    if (result.rowCount !== 1) throw new Error("Reward signing fence was lost.");
  });
}
export async function persistRewardSignature(pool: Pool, actionId: string, bytes: Uint8Array, signed: SignedTransaction): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const updated = await tx.forModule("vault-rewards").write("vault_reward_actions", "UPDATE vault_reward_actions SET state='signed',signature=$4 WHERE action_id=$1 AND state='signing' AND transaction_bytes=$2 AND digest=$3 AND (signature IS NULL OR signature=$4) RETURNING action_id", [actionId, Buffer.from(bytes), signed.digest, signed.signature]);
    return updated.rowCount === 1;
  });
}
export async function resolveRewardAction(pool: Pool, actionId: string, state: "executed" | "failed" | "expired"): Promise<void> {
  await withTransaction(pool, (tx) => tx.forModule("vault-rewards").write("vault_reward_actions", "UPDATE vault_reward_actions SET state=$2 WHERE action_id=$1 AND state IN ('signing','signed')", [actionId, state]));
}
