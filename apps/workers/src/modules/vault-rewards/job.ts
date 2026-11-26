import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions";
import { vaultDeployment } from "@interest-protocol/blast-deployments-sdk";
import { getVault, getRound, rewardIsClaimed, type RoundTerms } from "@interest-protocol/blast-vault-sdk/state";
import { VAULT_PAUSE_BITS } from "@interest-protocol/blast-vault-sdk/transactions";
import type { RewardProof } from "@interest-protocol/blast-core/rewards/allocations";
import type { Pool } from "pg";
import { autocommitRead, withTransaction } from "@blast/core/modules/database/transaction.ts";
import type { WorkerJob, JobContext, ProtocolWorkerAccess } from "#workers/modules/worker-runtime/runtime.ts";
import { adminCapReference } from "#workers/modules/worker-runtime/admin.ts";
import { sendOnce } from "#workers/modules/worker-runtime/attempt.ts";
import { readDigestOutcome } from "#workers/modules/worker-runtime/outcome.ts";
import { ProviderUnavailable } from "#workers/modules/worker-runtime/provider.ts";
import { frozenSchema, hasHolderAllocation, json, planCommitment, readPlan, type Frozen, type Plan, type Cut, PAGE_SIZE, CLAIM_WINDOW_MS } from "#workers/modules/reward-plan/plan.ts";
import { completeCut, MissingRewardHistory } from "#workers/modules/reward-plan/evidence.ts";
import { manifestReader } from "#workers/modules/reward-plan/manifest-store.ts";
import { assertAccountLeaves, ObjectBeneficiary, objectAddresses, type CheckIdentities } from "#workers/modules/reward-plan/beneficiaries.ts";
import { settlementEvidence } from "#workers/modules/reward-plan/gas-settlement.ts";
import { parseRewardIntent, rewardTransaction, manifestSummary, sameRewardKind, type RewardIntent } from "./transactions.ts";
import { rewardAction, reserveRewardBytes, assertRewardBytes, persistRewardSignature, resolveRewardAction, type RewardAction } from "./custody.ts";
import { errorLabel } from "@blast/core/lib/metrics.ts";
import { JOB_STALLED_AFTER_MS, type WorkerAlerts } from "#workers/modules/worker-runtime/alerts.ts";
import { recordGas } from "./gas.ts";
import type { RewardsSettings } from "./settings.ts";
import type { RewardsSigner } from "./signer.ts";
import { fitClaimBatch, fitClaimGas, rewardClaimIntent } from "./claim-batch.ts";
import { REWARD_CLAIM_GAS_LIMIT_MIST } from "./claim-limits.ts";

type Context = JobContext<ProtocolWorkerAccess, RewardsSigner>;

export function pendingMatches(terms: RoundTerms, f: Frozen, summary: ReturnType<typeof manifestSummary>): boolean {
  return terms.number === BigInt(f.number) && terms.start_checkpoint === BigInt(f.roundStart) && terms.end_checkpoint === BigInt(f.end.checkpoint)
    && terms.root === summary.root && terms.manifest_digest === summary.manifestDigest && terms.leaf_count === BigInt(summary.leafCount)
    && terms.meme_amount === BigInt(summary.memeAmount) && terms.quote_amount === BigInt(summary.quoteAmount)
    && terms.gas_reserve_amount === BigInt(f.reserve) && terms.claim_window_duration_ms === BigInt(CLAIM_WINDOW_MS) && terms.expected_treasury === f.treasury;
}

async function validatePlan(pool: Pool, intent: RewardIntent): Promise<void> {
  const p = await readPlan(pool, intent.planId), f = frozenSchema.parse(p.inputs), m = manifestSummary(p.manifest);
  const expected = planCommitment(f, p.manifest, p.storage_hash);
  const commitment = (p.inputs as Record<string, unknown>).commitment;
  if (!p.storage_verified_at || p.storage_hash !== intent.storageHash || commitment !== expected || f.fingerprint !== intent.fingerprint || f.vaultId !== intent.vault.objectId || f.memeType !== intent.memeType || f.quoteType !== intent.quoteType || f.treasury !== intent.treasury || f.reserve !== intent.reserve || json(m) !== json(intent.manifest)) throw new Error("Reward action differs from its reserved immutable plan.");
  if (intent.kind === "schedule_round" || intent.kind === "publish_round") {
    if (!hasHolderAllocation(f.payoutPolicy, m.memeAmount, m.quoteAmount)) throw new Error("Reward publication requires a holder Quote payout.");
    if (!f.payoutPolicy) throw new Error("Reward publication requires a plan under the current payout policy.");
    if (BigInt(m.memeAmount) > BigInt(f.grossMeme)) throw new Error("Reward publication exceeds its frozen Meme budget.");
    const treasuryLeaf = await autocommitRead(pool, "vault-rewards",
      "SELECT 1 FROM vault_reward_allocations WHERE plan_id=$1 AND beneficiary=$2", [p.plan_id, f.treasury]);
    if (treasuryLeaf.rowCount) throw new Error("Reward publication cannot pay a holder reward to the treasury.");
  }
  if (intent.kind === "settle_gas_reserve") {
    const e = await settlementEvidence(pool, intent.planId, BigInt(f.reserve));
    if (e.reimbursement !== intent.reimbursement || e.gasEffectCount !== intent.gasEffectCount || e.gasEffectsHash !== intent.gasEffectsHash) throw new Error("Reward settlement differs from finalized gas evidence.");
  }
}

/** The current indexed cut of a deployment: identity answers must be proven at or after it. */
async function currentCut(context: Context, fingerprint: string): Promise<Cut> {
  return withTransaction(context.pool, (tx) => completeCut(tx, fingerprint), { isolationLevel: "REPEATABLE READ" });
}

/**
 * A stored claim or publish is checked again at the current cut before it is resent: an account
 * answer holds only through the checkpoint it was proven at.
 */
async function recheckLeaves(context: Context, check: CheckIdentities, intent: RewardIntent): Promise<void> {
  if (intent.kind !== "claim" && intent.kind !== "publish_round") return;
  const cut = BigInt((await currentCut(context, intent.fingerprint)).checkpoint);
  if (intent.kind === "publish_round") {
    await assertAccountLeaves(context.pool, intent.planId, intent.manifest.leafCount, cut, check);
    return;
  }
  const objects = await objectAddresses(check, intent.leaves.map((leaf) => leaf.beneficiary), cut);
  if (objects.size) throw new ObjectBeneficiary([...objects].sort());
}

/**
 * Resolve or resend existing bytes before creating any new action of this plan. A stored claim is
 * checked again before it is resent: a leaf that is now an object is never paid.
 *
 * It reads the digest as `settleSubmission` does (executed or failed, else unknown) but is not that
 * function: its expiry is the stored bytes' own `ValidDuring` epoch, an action with no persisted
 * signature waits instead of resending, a resend first re-validates the plan and rechecks the
 * leaves, and it sends the stored signature without signing again.
 */
async function recoverAction(context: Context, check: CheckIdentities, action: RewardAction, settings: RewardsSettings): Promise<boolean> {
  const intent = parseRewardIntent(action.payload);
  if (!action.digest || !action.transaction_bytes || action.digest !== TransactionDataBuilder.getDigestFromBytes(action.transaction_bytes) || intent.fingerprint !== context.fingerprint || ("admin" in intent && intent.admin.objectId !== settings.adminCapId) || !sameRewardKind(action.transaction_bytes, context.deployment, intent)) throw new Error("Stored reward custody is inconsistent.");
  const digest = action.digest;
  const outcome = async () => {
    const read = await readDigestOutcome(context.client, context.provider, digest, { effects: true });
    return read.kind === "executed" || read.kind === "failed" ? read.kind : null;
  };
  let result = await outcome();
  if (!result) {
    const bytes = action.transaction_bytes, data = Transaction.from(bytes).getData();
    if (data.expiration?.$kind !== "ValidDuring" || data.expiration.ValidDuring.maxEpoch === null) throw new Error("Stored reward expiration is invalid.");
    const { systemState } = await context.provider((signal) => context.client.core.getCurrentSystemState({ signal }));
    if (BigInt(systemState.epoch) > BigInt(data.expiration.ValidDuring.maxEpoch)) {
      await resolveRewardAction(context.pool, action.action_id, "expired");
      return true;
    }
    if (!action.signature) return false;
    await validatePlan(context.pool, intent);
    await recheckLeaves(context, check, intent);
    await sendOnce(context.client, bytes, { digest: action.digest, signature: action.signature }, { providerTimeoutMs: context.config.timings.providerTimeoutMs, confirmTimeoutMs: context.config.timings.confirmTimeoutMs });
    result = await outcome();
  }
  if (!result) return false;
  await resolveRewardAction(context.pool, action.action_id, result);
  return true;
}

async function submitIntent(
  context: Context,
  check: CheckIdentities,
  value: RewardIntent,
  settings: RewardsSettings,
  estimatedGasBudgetMist?: bigint,
): Promise<void> {
  // Claim sizing may try several prefixes. Only a candidate that can sign needs a journal row.
  let action = value.kind === "claim" ? null : await rewardAction(context.pool, value, context.config.maxAttempts);
  if (!action && value.kind !== "claim") return;
  if (action && action.state !== "ready") {
    await recoverAction(context, check, action, settings);
    return;
  }

  const intent = parseRewardIntent(action?.payload ?? value);
  await validatePlan(context.pool, intent);
  const transaction = rewardTransaction(context.deployment, intent);
  const result = await context.submit({
    recordKeys: intent.kind === "claim" ? intent.leaves.map((leaf) => `${intent.planId}:leaf:${leaf.index}`) : [intent.operation],
    intent,
    transaction,
    estimatedGasBudgetMist,
    inputReservation: {
      beforeSign: async (bytes) => {
        await validatePlan(context.pool, intent);
        action ??= await rewardAction(context.pool, intent, context.config.maxAttempts);
        if (!action || action.state !== "ready") throw new Error("Reward action is no longer available to sign.");
        await reserveRewardBytes(context.pool, action, bytes);
      },
      afterSign: (bytes) => {
        if (!action) throw new Error("Reward action must be reserved before signing.");
        return assertRewardBytes(context.pool, action.action_id, bytes);
      },
    },
    beforeSubmit: (digest, signed, bytes) =>
      action && digest === signed.digest ? persistRewardSignature(context.pool, action.action_id, bytes, signed) : Promise.resolve(false),
    reconcile: async () => null,
  });
  if (result.digest && action) {
    const latest = (await autocommitRead<RewardAction>(context.pool, "vault-rewards", "SELECT * FROM vault_reward_actions WHERE action_id=$1", [action.action_id])).rows[0];
    if (latest && ["signed", "signing"].includes(latest.state)) await recoverAction(context, check, latest, settings);
  }
}

type Common = Omit<Extract<RewardIntent, { kind: "publish_round" }>, "kind" | "operation">;
type Vault = Awaited<ReturnType<typeof getVault>>;
type Round = Awaited<ReturnType<typeof getRound>>;
type Summary = ReturnType<typeof manifestSummary>;

/**
 * The read-only identity checker, and the plans whose leaves it already proved are accounts in this
 * process. A manifest is fixed once reserved, so scheduling checks a plan once. Publishing makes the
 * round claimable and is checked again at the current cut, because an account answer holds only
 * through the checkpoint it was proven at.
 */
type Identities = Readonly<{ check: CheckIdentities; accountPlans: Set<string> }>;

async function assertLeaves(context: Context, identities: Identities, planId: string, leafCount: number, cut: bigint): Promise<void> {
  if (identities.accountPlans.has(planId)) return;
  await assertAccountLeaves(context.pool, planId, leafCount, cut, identities.check);
  identities.accountPlans.add(planId);
}

async function preparePublication(context: Context, identities: Identities, p: Plan, settings: RewardsSettings, f: Frozen, manifest: Summary, common: Common, vault: Vault, cut: Cut): Promise<void> {
    if (vault.nextRound !== BigInt(f.number)) throw new Error("Reward publication is waiting for matching indexed evidence.");
    if ((context.protocol.paused.vault & VAULT_PAUSE_BITS.Admin) !== 0) return;
    const pending = vault.pendingRoundPublication;
    if (pending) {
      if (pending.value.kind !== "Action" || !pendingMatches(pending.value.action, f, manifest)) throw new Error("A different delayed round occupies this vault.");
      await withTransaction(context.pool, (tx) => tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET stage='scheduled' WHERE plan_id=$1 AND stage='reserved'", [p.plan_id]));
      if (pending.ready_at_ms > BigInt(cut.timestampMs)) return;
      await assertAccountLeaves(context.pool, p.plan_id, manifest.leafCount, BigInt(cut.checkpoint), identities.check);
      await submitIntent(context, identities.check, { ...common, kind: "publish_round", operation: `${p.plan_id}:publish` }, settings);
    } else {
      const admin = await adminCapReference(context.client, settings.adminCapId, context.signer.address, context.provider);
      if (!admin) throw new Error("RewardsAdmin capability is not owned by the rewards signer.");
      await assertLeaves(context, identities, p.plan_id, manifest.leafCount, BigInt(cut.checkpoint));
      await submitIntent(context, identities.check, { ...common, kind: "schedule_round", operation: `${p.plan_id}:schedule`, admin, claimWindowMs: CLAIM_WINDOW_MS }, settings);
    }

}

/**
 * Up to `relayBatch` unclaimed leaves whose beneficiary is still an account, read-only checked just
 * before the claim is sent. A leaf that is now an object is held back, never paid: its coin would be
 * stranded at the object's address.
 */
/** Check only the proof prefix that can fit, refilling any slots taken by objects. */
async function collectClaimPage(
  open: readonly RewardProof[],
  leaves: RewardProof[],
  held: RewardProof[],
  relayBatch: number,
  sizePrefix: (leaves: readonly RewardProof[]) => number,
  check: CheckIdentities,
  cut: bigint,
): Promise<boolean> {
  for (let next = 0; next < open.length && leaves.length < relayBatch;) {
    const available = open.slice(next, next + relayBatch - leaves.length);
    const fitting = sizePrefix([...leaves, ...available]) - leaves.length;
    if (fitting === 0) return true;
    const chunk = available.slice(0, fitting);
    next += chunk.length;
    const objects = await objectAddresses(check, chunk.map((leaf) => leaf.beneficiary), cut);
    for (const leaf of chunk) (objects.has(leaf.beneficiary) ? held : leaves).push(leaf);
    if (fitting < available.length && objects.size === 0) return true;
  }
  return false;
}

export async function unclaimedLeaves(
  context: Pick<Context, "pool">,
  check: CheckIdentities,
  planId: string,
  leafCount: number,
  round: Round,
  relayBatch: number,
  cut: bigint,
  sizePrefix: (leaves: readonly RewardProof[]) => number = (leaves) => leaves.length,
) {
  const store = manifestReader(context.pool, planId);
  const leaves: RewardProof[] = [], held: RewardProof[] = [];
  for (let offset = 0; offset < leafCount && leaves.length < relayBatch; offset += PAGE_SIZE) {
    const count = Math.min(PAGE_SIZE, leafCount - offset);
    const proofs = await store.readProofs(offset, count);
    if (proofs.length !== count) throw new Error("Reward proof page is incomplete.");
    const open = proofs.filter((leaf) => !rewardIsClaimed(round.claimedBitmap, Number(leaf.index)));
    if (await collectClaimPage(open, leaves, held, relayBatch, sizePrefix, check, cut)) break;
  }
  return { leaves, held };
}

async function settleRound(context: Context, check: CheckIdentities, p: Plan, settings: RewardsSettings, f: Frozen, common: Common, roundRef: { objectId: string; initialSharedVersion: string }) {
    if ((context.protocol.paused.vault & VAULT_PAUSE_BITS.Admin) !== 0) return;
    const prepared = (p.inputs as Record<string, unknown>).gasSettlement;
    if (!prepared || typeof prepared !== "object") return;
    const measured = await settlementEvidence(context.pool, p.plan_id, BigInt(f.reserve));
    if (json(prepared) !== json(measured)) throw new Error("Planner gas settlement differs from finalized execution evidence.");
    const admin = await adminCapReference(context.client, settings.adminCapId, context.signer.address, context.provider);
    if (!admin) throw new Error("RewardsAdmin capability is unavailable.");
    await submitIntent(context, check, { ...common, kind: "settle_gas_reserve", round: roundRef, admin, ...measured, operation: `${p.plan_id}:gas` }, settings);
}

/** Marks the plan's open leaves as held for good: an object answer is forever. */
async function recordHeldLeaves(context: Context, planId: string, indices: readonly string[]): Promise<void> {
  await withTransaction(context.pool, (tx) => tx.forModule("rewards-planner").write("vault_reward_plans",
    "UPDATE vault_reward_plans SET inputs=inputs||jsonb_build_object('heldLeaves',$2::jsonb) WHERE plan_id=$1 AND stage='published' AND NOT inputs ? 'heldLeaves'", [planId, JSON.stringify(indices)]));
}

export async function relayRound(context: Context, check: CheckIdentities, p: Plan, settings: RewardsSettings, f: Frozen, manifest: Summary, common: Common, round: Round, cut: Cut) {
  if (round.vaultId !== f.vaultId || round.number !== BigInt(f.number) || round.root !== manifest.root || round.leafCount !== manifest.leafCount || round.treasury !== f.treasury || round.memeType !== f.memeType || round.quoteType !== f.quoteType) throw new Error("Reward Round differs from the committed publication.");
  const roundRef = { objectId: round.objectId, initialSharedVersion: String(round.initialSharedVersion) };
  if (BigInt(cut.timestampMs) >= round.claimDeadlineAtMs) {
    await submitIntent(context, check, { ...common, kind: "close_round", round: roundRef, operation: `${p.plan_id}:close` }, settings);
    return;
  }
  const estimate = await context.gasEstimator(REWARD_CLAIM_GAS_LIMIT_MIST);
  if (!estimate) return;
  const claim = { ...common, kind: "claim" as const, round: roundRef };
  const { leaves, held } = await unclaimedLeaves(context, check, p.plan_id, manifest.leafCount, round, settings.relayBatch,
    BigInt(cut.checkpoint), (candidates) => fitClaimBatch(context.deployment, claim, candidates).leaves.length);
  if (leaves.length) {
    const initial = rewardClaimIntent(claim, leaves);
    const fit = await fitClaimGas(claim, initial, (intent) => estimate(rewardTransaction(context.deployment, intent)));
    // The next relay pass reads the bitmap again and picks up the unpaid suffix.
    if (fit) await submitIntent(context, check, fit.intent, settings, fit.budgetMist);
  } else {
    // No account leaf is left, so every open leaf is held: record them, so the planner measures gas
    // now instead of waiting for claims that never come, and settle once it has.
    if (held.length) await recordHeldLeaves(context, p.plan_id, held.map((leaf) => leaf.index));
    if (round.gasReserve !== null) await settleRound(context, check, p, settings, f, common, roundRef);
  }
  // A published leaf that pays an object breaks the main rule: block the plan and alert, after
  // relaying the account leaves and settling gas.
  if (held.length) throw new ObjectBeneficiary([...new Set(held.map((leaf) => leaf.beneficiary))].sort());

}

async function runPlan(context: Context, identities: Identities, p: Plan, settings: RewardsSettings): Promise<void> {
  const f = frozenSchema.parse(p.inputs), manifest = manifestSummary(p.manifest);
  const clientDeployment = vaultDeployment(context.deployment);
  const vault = await context.provider(() => getVault(context.client, f.vaultId, clientDeployment));
  if (vault.memeType !== f.memeType || vault.quoteType !== f.quoteType || vault.poolId !== f.poolId || vault.terms.origin !== f.originId) throw new Error("Reward vault differs from frozen origin, assets or pool.");
  const common = { planId: p.plan_id, fingerprint: f.fingerprint, memeType: f.memeType, quoteType: f.quoteType,
    vault: { objectId: vault.objectId, initialSharedVersion: String(vault.initialSharedVersion) }, manifest, storageHash: p.storage_hash!, treasury: f.treasury, reserve: f.reserve };
  const cut = await currentCut(context, f.fingerprint);
  const { rows } = await autocommitRead<{ round_id: string; root: string; manifest_digest: string; meme_amount: string; quote_amount: string; leaf_count: string; treasury: string; gas_reserve_amount: string; closed: boolean }>(
    context.pool, "vault-rewards", "SELECT round_id,root,manifest_digest,meme_amount::text,quote_amount::text,leaf_count::text,treasury,gas_reserve_amount::text,closed FROM chain_read_v1.vault_rounds WHERE vault_id=$1 AND number=$2 AND published_checkpoint<=$3", [f.vaultId, f.number, cut.checkpoint]);
  const indexed = rows[0];
  if (!indexed) {
    await preparePublication(context, identities, p, settings, f, manifest, common, vault, cut);
    return;
  }
  if (indexed.root !== manifest.root || indexed.manifest_digest !== manifest.manifestDigest || indexed.meme_amount !== manifest.memeAmount || indexed.quote_amount !== manifest.quoteAmount || indexed.leaf_count !== String(manifest.leafCount) || indexed.treasury !== f.treasury || indexed.gas_reserve_amount !== f.reserve) throw new Error("Indexed reward publication differs from reserved manifest.");
  await withTransaction(context.pool, async (tx) => {
    await tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET stage=$2 WHERE plan_id=$1", [p.plan_id, indexed.closed ? "closed" : "published"]);
    await tx.forModule("rewards-planner").write("vault_reward_periods", "UPDATE vault_reward_periods SET status='funded' WHERE period_id=$1", [p.period_id]);
  });
  if (indexed.closed) return;
  const round = await context.provider(() => getRound(context.client, indexed.round_id, clientDeployment));
  await relayRound(context, identities.check, p, settings, f, manifest, common, round, cut);
}

async function reportBlocked(context: Context, alerts: WorkerAlerts | undefined, kind: string, planId: string, error: unknown) {
  const details = { planId, error: errorLabel(error), reason: error instanceof MissingRewardHistory ? error.reason : "execution-evidence" };
  context.log("vault_rewards.blocked", details);
  await alerts?.raise(`${kind}:${planId}`, details, { graceMs: JOB_STALLED_AFTER_MS });
}

async function accountGas(context: Context, settings: RewardsSettings, alerts: WorkerAlerts | undefined, after: string | null) {
  const { rows } = await autocommitRead<RewardAction>(context.pool, "vault-rewards", `SELECT a.* FROM vault_reward_actions a
    LEFT JOIN vault_reward_gas_effects g USING(digest) WHERE a.state IN ('executed','failed')
    AND a.kind IN ('schedule_round','publish_round','claim') AND a.payload->>'fingerprint'=$1
    AND g.digest IS NULL AND ($3::uuid IS NULL OR a.action_id>$3) ORDER BY a.action_id LIMIT $2`, [context.fingerprint, context.config.batchSize, after]);
  const failed = new Set<string>(), plans = new Set<string>();
  for (const action of rows) {
    plans.add(action.plan_id);
    try {
      const outcome = await readDigestOutcome(context.client, context.provider, action.digest!, { effects: true });
      if (outcome.kind === "unknown") throw outcome.error;
      // Not found is a failed node call here, as a bounded provider reports it.
      if (outcome.kind === "not-found") throw new ProviderUnavailable("error");
      if (outcome.kind !== "executed" && outcome.kind !== "failed") throw new MissingRewardHistory("finalized-gas-receipt");
      await recordGas(context.pool, action, outcome.transaction, settings.pricePolicy);
    } catch (error) { failed.add(action.plan_id); await reportBlocked(context, alerts, "reward_gas", action.plan_id, error); }
  }
  for (const planId of plans) if (!failed.has(planId)) await alerts?.clear(`reward_gas:${planId}`);
  return rows.at(-1)?.action_id ?? null;
}

/** `check` is the read-only identity checker: the leaf check and the relay save no answer. */
export function vaultRewardsJob(settings: RewardsSettings, check: CheckIdentities, alerts?: WorkerAlerts): WorkerJob<ProtocolWorkerAccess, RewardsSigner> {
  let afterPlan: string | null = null;
  let afterAction: string | null = null;
  let afterGas: string | null = null;
  const identities: Identities = { check, accountPlans: new Set() };
  return {
    name: "vault-rewards", inputReservations: true,
    sign: (signer, bytes, intent, deployment, beforeCrypto) => signer.sign(bytes, intent, deployment, beforeCrypto),
    async run(context) {
      const { rows: pending } = await autocommitRead<RewardAction>(context.pool, "vault-rewards", "SELECT * FROM vault_reward_actions WHERE state IN ('signing','signed') AND payload->>'fingerprint'=$1 AND ($3::uuid IS NULL OR action_id>$3) ORDER BY action_id LIMIT $2", [context.fingerprint, context.config.batchSize, afterAction]);
      const blockedPlans = new Set<string>();
      if (!pending.length) afterAction = null;
      for (const action of pending) {
        afterAction = action.action_id;
        try {
          if (!await recoverAction(context, check, action, settings)) blockedPlans.add(action.plan_id);
          else await alerts?.clear(`reward_custody:${action.plan_id}`);
        } catch (error) { blockedPlans.add(action.plan_id); await reportBlocked(context, alerts, "reward_custody", action.plan_id, error); }
      }
      afterGas = await accountGas(context, settings, alerts, afterGas);
      const { rows: plans } = await autocommitRead<Plan>(context.pool, "vault-rewards", `SELECT p.* FROM vault_reward_plans p JOIN vault_reward_periods d USING(period_id)
        WHERE d.deployment_fingerprint=$1 AND p.stage IN ('reserved','scheduled','published')
        AND (p.stage<>'published' OR NOT EXISTS(SELECT 1 FROM chain_read_v1.vault_rounds r WHERE r.vault_id=d.vault_id AND r.number=p.number)
          OR EXISTS(SELECT 1 FROM chain_read_v1.vault_rounds r WHERE r.vault_id=d.vault_id AND r.number=p.number
            AND (r.closed OR r.claimed_count<r.leaf_count OR (NOT r.gas_settled AND r.gas_reserve_amount>0)
              OR r.claim_deadline_at_ms<=(SELECT max(timestamp_ms) FROM chain_read_v1.checkpoint_headers))))
        AND ($3::uuid IS NULL OR p.plan_id>$3) ORDER BY p.plan_id LIMIT $2`, [context.fingerprint, context.config.batchSize, afterPlan]);
      if (!plans.length) afterPlan = null;
      for (const p of plans) {
        afterPlan = p.plan_id;
        if (blockedPlans.has(p.plan_id)) continue;
        try { await runPlan(context, identities, p, settings); await alerts?.clear(`reward_plan:${p.plan_id}`); }
        catch (error) { await reportBlocked(context, alerts, "reward_plan", p.plan_id, error); }
      }
      return { blocked: null };
    },
  };
}
