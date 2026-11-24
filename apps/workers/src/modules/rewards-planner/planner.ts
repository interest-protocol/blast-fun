import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { allocateHolderRewardPage, validateRewardManifestSummary } from "@interest-protocol/blast-core/rewards/allocations";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { launchpadDeployment, presaleDeployment } from "@interest-protocol/blast-deployments-sdk";
import { decodeLaunchpadEvent } from "@interest-protocol/blast-launchpad-sdk/events";
import { decodePresaleEvent } from "@interest-protocol/blast-presale-sdk/events";
import { withTransaction, type TransactionContext } from "@blast/core/modules/database/transaction.ts";
import { objectIdSchema } from "#workers/lib/validation.ts";
import { answerEvery, type AddressIdentity, type CheckIdentities } from "#workers/modules/reward-plan/beneficiaries.ts";
import { completeCut, MissingRewardHistory, requireRewardCut } from "#workers/modules/reward-plan/evidence.ts";
import { PAGE_SIZE, CLAIM_WINDOW_MS, frozenSchema, json, planCommitment, type Cut, type Frozen, type Plan } from "#workers/modules/reward-plan/plan.ts";
import { DAY_MS, MAX_POSITIVE_LEAVES, gasReserveFits, minimumWeight } from "./economics.ts";
import { historicalFunds, historicalTreasury, nativeEvent } from "./history.ts";

export type PlannerSettings = Readonly<{ fingerprint: string; gasReserveBps: number; maxAgeMs: number; maxConfidenceBps: number; exclusions: readonly string[] }>;
type Holder = { owner: string; weight: string; start_checkpoint: string; start_digest: string; end_checkpoint: string; end_digest: string };
type Vault = { vault_id: string; origin_id: string; origin_kind: string; meme_type: string; quote_type: string; pool_id: string; next_round: string; created_timestamp_ms: string; created_checkpoint: string };

async function boundary(tx: TransactionContext, timestamp: string): Promise<Cut> {
  const { rows } = await tx.read<{ checkpoint: string; digest: string; timestamp_ms: string }>(
    "SELECT checkpoint::text,digest,timestamp_ms::text FROM chain_read_v1.checkpoint_headers WHERE timestamp_ms<=$1 ORDER BY timestamp_ms DESC,checkpoint DESC LIMIT 1", [timestamp]);
  const row = rows[0];
  if (!row) throw new MissingRewardHistory("daily-boundary");
  return { checkpoint: row.checkpoint, digest: row.digest, timestampMs: row.timestamp_ms };
}
async function price(tx: TransactionContext, settings: PlannerSettings, coin: string, cut: Cut, endMs: string) {
  const { rows } = await tx.read<{ observation: unknown }>(
    "SELECT chain_read_v1.usd_observation('mainnet',$1,$2,$3,$4,4294967295,4294967295,$5,$6,$7) AS observation",
    [settings.fingerprint, coin, cut.checkpoint, cut.digest, endMs, settings.maxAgeMs, settings.maxConfidenceBps]);
  const value = z.looseObject({ available: z.literal(true), numerator: z.string().regex(/^[1-9][0-9]*$/), denominator: z.string().regex(/^[1-9][0-9]*$/), exponent: z.number().int().min(-255).max(255) }).safeParse(rows[0]?.observation);
  if (!value.success) throw new MissingRewardHistory("financial-price");
  let numerator = BigInt(value.data.numerator), denominator = BigInt(value.data.denominator);
  if (value.data.exponent < 0) denominator *= 10n ** BigInt(-value.data.exponent);
  else numerator *= 10n ** BigInt(value.data.exponent);
  return { numerator: numerator.toString(), denominator: denominator.toString(), evidence: value.data };
}

const MINIMUM_PAYOUT_USD = 100;

function meetsPayoutMinimum(amount: bigint, price: Frozen["quotePrice"], minimumUsd: number): boolean {
  return price !== null && amount * BigInt(price.numerator) >= BigInt(minimumUsd) * BigInt(price.denominator);
}

async function launchTeamWallets(tx: TransactionContext, deployment: BlastDeployment, vault: Vault, cut: Cut): Promise<string[]> {
  const prefix = `${deployment.packages.launchpad.originalPackageId}::events::LaunchCreated<`;
  const { rows } = await tx.read<{ events: unknown; digest: string; sender: string; checkpoint: string }>(
    `SELECT DISTINCT e.events,e.digest,e.sender,e.checkpoint::text FROM chain_read_v1.transaction_evidence e
     JOIN chain_read_v1.launch_activity a ON a.tx_digest=e.digest WHERE a.payload->>'launch_id'=$1
     AND a.event_type LIKE $2 AND e.checkpoint<=$3 AND e.success LIMIT 2`, [vault.origin_id, `${prefix}%`, cut.checkpoint]);
  const matches: string[][] = [];
  for (const row of rows) for (const [index, event] of z.array(z.object({ eventType: z.string(), bcs: z.string() })).parse(row.events).entries()) {
    if (!event.eventType.startsWith(prefix)) continue;
    const decoded = decodeLaunchpadEvent(nativeEvent(row, event, row.digest, index), launchpadDeployment(deployment));
    if (decoded.kind !== "LaunchCreated" || decoded.payload.launch_id !== vault.origin_id || decoded.memeType !== vault.meme_type || decoded.quoteType !== vault.quote_type) continue;
    matches.push(decoded.payload.allocation_plan.recipients.filter(share => share.memeBps > 0n).map(share => share.recipient.destination));
  }
  if (matches.length !== 1) throw new MissingRewardHistory("launch-allocation-evidence");
  return matches[0]!;
}

/** Creation terms are immutable; positive Meme allocations exclude direct and vested beneficiaries for both products. */
async function teamWallets(tx: TransactionContext, deployment: BlastDeployment, vault: Vault, cut: Cut): Promise<string[]> {
  if (vault.origin_kind === "launch") return launchTeamWallets(tx, deployment, vault, cut);
  const { rows } = await tx.read<{ events: unknown; digest: string; sender: string; checkpoint: string }>(
    `SELECT e.events,e.digest,e.sender,e.checkpoint::text FROM chain_read_v1.transaction_evidence e
     JOIN chain_read_v1.checkpoint_headers h ON h.checkpoint=e.checkpoint
     JOIN chain_read_v1.presales p ON p.created_at_ms=h.timestamp_ms
     WHERE p.presale_id=$1 AND p.sale_token=$2 AND e.checkpoint<=$3 AND e.success LIMIT 1001`, [vault.origin_id, vault.meme_type, cut.checkpoint]);
  if (rows.length > 1000) throw new MissingRewardHistory("presale-creation-cap");
  const matches: string[][] = [];
  const prefix = `${deployment.packages.presale.originalPackageId}::blast_presale::PresaleCreated<`;
  for (const row of rows) for (const [index, e] of z.array(z.object({ eventType: z.string(), bcs: z.string() })).parse(row.events).entries()) {
    if (!e.eventType.startsWith(prefix)) continue;
    const decoded = decodePresaleEvent(nativeEvent(row, e, row.digest, index), presaleDeployment(deployment));
    if (decoded.kind !== "PresaleCreated" || decoded.payload.presale_id !== vault.origin_id || decoded.saleTokenType !== vault.meme_type) continue;
    const p = decoded.payload;
    if (p.recipients.length !== p.recipient_bps.length) throw new MissingRewardHistory("presale-allocation-shape");
    matches.push(p.recipients.filter((_recipient, i) => p.recipient_bps[i]! > 0n).map((recipient) => recipient.destination));
  }
  if (matches.length !== 1) throw new MissingRewardHistory("presale-allocation-evidence");
  return matches[0]!;
}


/** Reserved payouts remain fenced until their publication is included in this exact cut. */
async function reservationsAtCut(tx: TransactionContext, fingerprint: string, vaultId: string, cut: Cut, exceptPlan: string | null = null) {
  const { rows } = await tx.read<Pick<Plan, "inputs" | "manifest">>(
    `SELECT p.inputs,p.manifest FROM vault_reward_plans p JOIN vault_reward_periods d USING(period_id)
     WHERE d.network='mainnet' AND d.deployment_fingerprint=$1 AND d.vault_id=$2 AND ($4::uuid IS NULL OR p.plan_id<>$4)
       AND p.stage IN ('reserved','scheduled','published','closed') AND NOT EXISTS (
         SELECT 1 FROM chain_read_v1.vault_rounds r WHERE r.vault_id=d.vault_id AND r.number=p.number AND r.published_checkpoint<=$3)`,
    [fingerprint, vaultId, cut.checkpoint, exceptPlan]);
  let meme = 0n, quote = 0n;
  for (const row of rows) {
    const f = frozenSchema.parse(row.inputs);
    const manifest = validateRewardManifestSummary(row.manifest as Parameters<typeof validateRewardManifestSummary>[0]);
    meme += BigInt(manifest.memeAmount);
    quote += BigInt(manifest.quoteAmount) + BigInt(f.reserve);
  }
  return { meme, quote };
}

export async function discoverPeriods(pool: Pool, settings: PlannerSettings, limit: number): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const cut = await completeCut(tx, settings.fingerprint);
    const { rows } = await tx.read<Vault & { start_ms: string }>(
      `SELECT v.vault_id,v.origin_id,v.origin_kind,v.meme_type,v.quote_type,v.pool_id,v.next_round::text,v.created_timestamp_ms::text,v.created_checkpoint::text,
        coalesce((SELECT max(end_ms) FROM vault_reward_periods d WHERE d.network='mainnet' AND d.deployment_fingerprint=$1 AND d.vault_id=v.vault_id),v.created_timestamp_ms)::text AS start_ms
       FROM chain_read_v1.vaults v WHERE coalesce((SELECT max(end_ms) FROM vault_reward_periods d WHERE d.network='mainnet' AND d.deployment_fingerprint=$1 AND d.vault_id=v.vault_id),v.created_timestamp_ms)+86400000<=$2
       AND NOT EXISTS(SELECT 1 FROM vault_reward_periods d WHERE d.network='mainnet' AND d.deployment_fingerprint=$1 AND d.vault_id=v.vault_id AND d.status NOT IN ('funded','skipped'))
       ORDER BY v.created_timestamp_ms,v.vault_id LIMIT $3`, [settings.fingerprint, cut.timestampMs, limit]);
    for (const v of rows) {
      const end = BigInt(v.start_ms) + DAY_MS;
      if (end > BigInt(cut.timestampMs)) continue;
      await tx.forModule("rewards-planner").write("vault_reward_periods",
        `INSERT INTO vault_reward_periods(period_id,network,deployment_fingerprint,vault_id,start_ms,end_ms,status)
         VALUES($1,'mainnet',$2,$3,$4,$5,'planning') ON CONFLICT(network,deployment_fingerprint,vault_id,start_ms) DO NOTHING`, [randomUUID(), settings.fingerprint, v.vault_id, v.start_ms, end.toString()]);
    }
  }, { isolationLevel: "REPEATABLE READ", retry: true });
}

export async function freezePeriod(pool: Pool, deployment: BlastDeployment, settings: PlannerSettings, periodId: string): Promise<string> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.read<{ vault_id: string; start_ms: string; end_ms: string; status: string }>(
      "SELECT vault_id,start_ms::text,end_ms::text,status FROM vault_reward_periods WHERE period_id=$1 AND deployment_fingerprint=$2 FOR UPDATE", [periodId, settings.fingerprint]);
    const period = rows[0];
    if (!period || period.status !== "planning") throw new MissingRewardHistory("period-state");
    const existing = await tx.read<Pick<Plan, "plan_id" | "inputs">>("SELECT plan_id,inputs FROM vault_reward_plans WHERE period_id=$1", [periodId]);
    if (existing.rows[0]) {
      if (!frozenSchema.parse(existing.rows[0].inputs).payoutPolicy) {
        throw new MissingRewardHistory("reward-payout-policy-cutover");
      }
      return existing.rows[0].plan_id;
    }
    const start = await boundary(tx, period.start_ms), end = await boundary(tx, period.end_ms);
    await requireRewardCut(tx, settings.fingerprint, end);
    const { rows: vaults } = await tx.read<Vault>(
      "SELECT vault_id,origin_id,origin_kind,meme_type,quote_type,pool_id,next_round::text,created_timestamp_ms::text,created_checkpoint::text FROM chain_read_v1.vaults WHERE vault_id=$1 AND created_checkpoint<=$2", [period.vault_id, end.checkpoint]);
    const vault = vaults[0];
    if (!vault) throw new MissingRewardHistory("vault-creation");
    const policy = await historicalTreasury(tx, deployment, end), sourceFunds = await historicalFunds(tx, deployment, settings.fingerprint, vault.vault_id, end);
    const committed = await reservationsAtCut(tx, settings.fingerprint, vault.vault_id, end);
    const funds = { meme: sourceFunds.meme - committed.meme, quote: sourceFunds.quote - committed.quote, evidence: { ...sourceFunds.evidence, reservedMeme: committed.meme.toString(), reservedQuote: committed.quote.toString() } };
    if (funds.meme < 0n || funds.quote < 0n) throw new MissingRewardHistory("negative-unreserved-funds");
    const { rows: previous } = await tx.read<{ end_checkpoint: string }>("SELECT end_checkpoint::text FROM chain_read_v1.vault_rounds WHERE vault_id=$1 ORDER BY number DESC LIMIT 1", [vault.vault_id]);
    const roundStart = previous[0]?.end_checkpoint ?? start.checkpoint;
    if (BigInt(roundStart) >= BigInt(end.checkpoint)) throw new MissingRewardHistory("round-overlap");
    const reserve = funds.quote * BigInt(settings.gasReserveBps) / 10000n;
    const quotePrice = funds.quote === 0n ? null : await price(tx, settings, vault.quote_type, end, period.end_ms);
    const canPayHolders = meetsPayoutMinimum(funds.quote - reserve, quotePrice, MINIMUM_PAYOUT_USD);
    const memePrice = canPayHolders ? await price(tx, settings, vault.meme_type, end, period.end_ms) : null;
    const holderExclusions = canPayHolders ? await excludedHolders(tx, deployment, vault, end) : [];
    const exclusions = [...new Set([...settings.exclusions, ...holderExclusions, ...policy.destinations, vault.vault_id, vault.origin_id, vault.pool_id])].sort();
    exclusions.forEach((value) => objectIdSchema.parse(value));
    const frozen = frozenSchema.parse({ network: "mainnet", fingerprint: settings.fingerprint, vaultId: vault.vault_id, memeType: vault.meme_type, quoteType: vault.quote_type, poolId: vault.pool_id, originId: vault.origin_id, number: vault.next_round,
      startMs: period.start_ms, endMs: period.end_ms, start, end, roundStart, treasury: policy.treasury, exclusions, memePrice, quotePrice, grossMeme: funds.meme.toString(), grossQuote: funds.quote.toString(), reserve: reserve.toString(), gasReserveBps: settings.gasReserveBps, claimWindowMs: CLAIM_WINDOW_MS, globalWeight: "0", qualifiers: 0, sourceEvidence: funds.evidence, payoutPolicy: "both-assets-to-holders" });
    const planId = randomUUID();
    await tx.forModule("rewards-planner").write("vault_reward_plans", "INSERT INTO vault_reward_plans(plan_id,period_id,number,stage,inputs) VALUES($1,$2,$3,'qualifying',$4)", [planId, periodId, frozen.number, json(frozen)]);
    return planId;
  }, { isolationLevel: "REPEATABLE READ", retry: true });
}

async function excludedHolders(tx: TransactionContext, deployment: BlastDeployment, vault: Vault, cut: Cut): Promise<string[]> {
  const { rows } = await tx.read<{ wallets: string[] }>("SELECT wallets FROM presale_reward_blacklists WHERE network='mainnet' AND coin_type=$1", [vault.meme_type]);
  return [...(rows[0]?.wallets ?? []), ...await teamWallets(tx, deployment, vault, cut)];
}

/** Answers this pass already proved, by address. */
export type KnownIdentities = ReadonlyMap<string, AddressIdentity>;

/** The plan's frozen inputs and holder cursor, if it is still qualifying. */
async function qualifyingPlan(tx: TransactionContext, planId: string, lock: boolean) {
  const { rows } = await tx.read<Plan>(`SELECT * FROM vault_reward_plans WHERE plan_id=$1${lock ? " FOR UPDATE" : ""}`, [planId]);
  const plan = rows[0];
  if (!plan || plan.stage !== "qualifying") throw new Error("Reward plan is not qualifying.");
  const f = frozenSchema.parse(plan.inputs);
  const cursor = z.object({ holderCursor: z.string().nullable().optional() }).parse(plan.inputs).holderCursor ?? null;
  return { plan, f, cursor };
}

/** The reward floor at the frozen price: the smallest weight that earns a leaf. */
function rewardFloor(f: Frozen): bigint {
  if (!f.memePrice) throw new MissingRewardHistory("holder-meme-price");
  return minimumWeight({ numerator: BigInt(f.memePrice.numerator), denominator: BigInt(f.memePrice.denominator) });
}

function holderQuoteBudget(f: Frozen): bigint {
  const quote = BigInt(f.grossQuote) - BigInt(f.reserve);
  return f.qualifiers > 0 && f.memePrice !== null && meetsPayoutMinimum(quote, f.quotePrice, Math.max(MINIMUM_PAYOUT_USD, f.qualifiers)) ? quote : 0n;
}

function canQualifyHolders(f: Frozen): boolean {
  return f.memePrice !== null && meetsPayoutMinimum(BigInt(f.grossQuote) - BigInt(f.reserve), f.quotePrice, MINIMUM_PAYOUT_USD);
}

async function skipPeriod(tx: TransactionContext, periodId: string, reason: "no-qualifiers" | "low-budget"): Promise<void> {
  await tx.forModule("rewards-planner").write("vault_reward_periods", "UPDATE vault_reward_periods SET status='skipped',inputs=$2 WHERE period_id=$1", [periodId, json({ reason })]);
}

/**
 * The next holder page after `cursor`, all of it measured at the frozen cut. The read raises for a
 * holder at or above the floor with no account answer proven through the cut, so it takes the same
 * floor as `reward_identity_gaps`; dust below it may come back unproven and never earns a leaf.
 */
async function holderPage(tx: TransactionContext, f: Frozen, cursor: string | null): Promise<Holder[]> {
  const { rows: holders } = await tx.read<Holder>(
    `SELECT owner,weight,start_checkpoint::text,start_digest,end_checkpoint::text,end_digest
     FROM chain_read_v1.reward_holder_window_since('mainnet',$1,$2,$3,$4,$5::text[],$6,$7,$8::numeric)`,
    [f.fingerprint, f.memeType, f.startMs, f.endMs, f.exclusions, cursor, PAGE_SIZE, rewardFloor(f).toString()]);
  if (holders.some((h) => h.start_checkpoint !== f.start.checkpoint || h.end_checkpoint !== f.end.checkpoint || h.start_digest !== f.start.digest || h.end_digest !== f.end.digest)) throw new MissingRewardHistory("holder-window-cut");
  return holders;
}

function qualifyingHolders(holders: readonly Holder[], f: Frozen): Holder[] {
  if (holders.length === 0) return [];
  const floor = rewardFloor(f);
  return holders.filter((h) => BigInt(h.weight) >= floor);
}

/**
 * The next page's gaps (holders at or above the reward floor at the frozen price, with no saved
 * answer proven through the cut), or, once there are none, the page's qualifying holders. One
 * snapshot, no lock.
 */
async function nextQuestions(pool: Pool, planId: string) {
  return withTransaction(pool, async (tx) => {
    const { f, cursor } = await qualifyingPlan(tx, planId, false);
    if (!canQualifyHolders(f)) return { gaps: [], qualifying: [], cut: BigInt(f.end.checkpoint) };
    const floor = rewardFloor(f);
    const { rows: gaps } = await tx.read<{ owner: string; end_checkpoint: string }>(
      `SELECT owner,end_checkpoint::text FROM chain_read_v1.reward_identity_gaps('mainnet',$1,$2,$3,$4,$5::text[],$6,$7,$8::numeric)`,
      [f.fingerprint, f.memeType, f.startMs, f.endMs, f.exclusions, cursor, PAGE_SIZE, floor.toString()]);
    if (gaps.some((gap) => gap.end_checkpoint !== f.end.checkpoint)) throw new MissingRewardHistory("holder-window-cut");
    const qualifying = gaps.length ? [] : qualifyingHolders(await holderPage(tx, f, cursor), f);
    return { gaps: gaps.map((gap) => gap.owner), qualifying: qualifying.map((h) => h.owner), cut: BigInt(f.end.checkpoint) };
  }, { isolationLevel: "REPEATABLE READ", retry: true });
}

/**
 * Every chain question for the next qualifying page, asked outside any lock. First the gaps: prove
 * each, save the answers in their own committed transaction, and repeat until none are left. Then
 * the page's qualifying holders that this pass has not answered: the indexer's holder window skips
 * only objects it saw itself, so an object only GraphQL knows (deleted, wrapped) comes back from it.
 * Those answers are read-only. Returns every answer for `qualifyPage`.
 */
export async function fillIdentityGaps(pool: Pool, planId: string, check: CheckIdentities): Promise<KnownIdentities> {
  const known = new Map<string, AddressIdentity>();
  for (;;) {
    const { gaps, qualifying, cut } = await nextQuestions(pool, planId);
    if (!gaps.length) {
      for (const answer of await answerEvery(check, qualifying.filter((owner) => !known.has(owner)), cut)) known.set(answer.address, answer);
      return known;
    }
    // A saved answer always closes its gap; one that reappears means the save did not hold.
    if (gaps.some((owner) => known.has(owner))) throw new Error("Holder identity gap stayed open after its answer was saved.");
    const answers = await answerEvery(check, gaps, cut);
    await withTransaction(pool, (tx) => tx.forModule("rewards-planner").write("chain_read_v1.record_address_identities",
      "SELECT chain_read_v1.record_address_identities($1::jsonb)",
      [json(answers.map((answer) => ({ address: answer.address, kind: answer.kind, proven_through: answer.provenThrough.toString(), source: "graphql" })))]));
    for (const answer of answers) known.set(answer.address, answer);
  }
}

/**
 * Object holders (contracts `holder_rewards`: leaves are accounts) get no leaf and no share of the
 * global weight. `known` must answer every qualifying holder on the page (`fillIdentityGaps`): no
 * chain call runs under the plan lock, and a holder left unanswered throws, so the next pass asks.
 */
export async function qualifyPage(pool: Pool, planId: string, known: KnownIdentities): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const { plan, f, cursor } = await qualifyingPlan(tx, planId, true);
    const canQualify = canQualifyHolders(f);
    const holders = canQualify ? await holderPage(tx, f, cursor) : [];
    const accounts = qualifyingHolders(holders, f).filter((h) => {
      const answer = known.get(h.owner);
      if (!answer) throw new Error("Identity check left a qualifying holder unanswered.");
      return answer.kind === "account";
    });
    let weight = BigInt(f.globalWeight);
    for (const holder of accounts) {
      weight += BigInt(holder.weight);
      await tx.forModule("rewards-planner").write("vault_reward_holders", "INSERT INTO vault_reward_holders(plan_id,beneficiary,weight) VALUES($1,$2,$3)", [planId, holder.owner, holder.weight]);
    }
    const complete = holders.length < PAGE_SIZE;
    const updated = { ...f, qualifiers: f.qualifiers + accounts.length, globalWeight: weight.toString(), holderCursor: holders.at(-1)?.owner ?? cursor };
    const skipped = complete && holderQuoteBudget(updated) === 0n;
    await tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET inputs=$2,stage=$3 WHERE plan_id=$1", [planId, json(updated), skipped ? "skipped" : complete ? "allocating" : "qualifying"]);
    if (skipped) await skipPeriod(tx, plan.period_id, canQualify && updated.qualifiers === 0 ? "no-qualifiers" : "low-budget");
    return complete;
  }, { isolationLevel: "REPEATABLE READ", retry: true });
}

export async function allocatePage(pool: Pool, planId: string): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.read<Plan>("SELECT * FROM vault_reward_plans WHERE plan_id=$1 FOR UPDATE", [planId]);
    const plan = rows[0];
    if (!plan || plan.stage !== "allocating") throw new Error("Reward plan is not allocating.");
    const f = frozenSchema.parse(plan.inputs);
    const progress = z.object({ allocationCursor: z.string().nullable().optional() }).parse(plan.inputs);
    const cursor = progress.allocationCursor ?? null;
    const quoteBudget = holderQuoteBudget(f);
    const { rows: holders } = quoteBudget === 0n ? { rows: [] } : await tx.read<{ beneficiary: string; weight: string }>("SELECT beneficiary,weight::text FROM vault_reward_holders WHERE plan_id=$1 AND ($2::text IS NULL OR beneficiary COLLATE \"C\">$2 COLLATE \"C\") ORDER BY beneficiary COLLATE \"C\" LIMIT $3", [planId, cursor, PAGE_SIZE]);
    const last = holders.at(-1)?.beneficiary ?? cursor;
    const complete = holders.length < PAGE_SIZE;
    const allocations = quoteBudget === 0n ? [] : allocateHolderRewardPage(
      holders.map((holder) => ({ address: holder.beneficiary, weight: BigInt(holder.weight) })),
      BigInt(f.grossMeme), quoteBudget, BigInt(f.globalWeight), cursor ?? undefined,
    ).allocations;
    const { rows: totals } = await tx.read<{ count: string }>("SELECT count(*)::text AS count FROM vault_reward_allocations WHERE plan_id=$1", [planId]);
    let index = Number(totals[0]!.count);
    if (BigInt(index + allocations.length) > MAX_POSITIVE_LEAVES) throw new Error("Reward allocations exceed the contract leaf cap.");
    for (const a of allocations) await tx.forModule("rewards-planner").write("vault_reward_allocations", "INSERT INTO vault_reward_allocations(plan_id,leaf_index,beneficiary,meme_amount,quote_amount) VALUES($1,$2,$3,$4,$5)", [planId, index++, a.beneficiary, a.memeAmount.toString(), a.quoteAmount.toString()]);
    let stage = complete ? "proofs" : "allocating";
    if (complete) {
      const { rows: amounts } = await tx.read<{ quote: string }>("SELECT coalesce(sum(quote_amount),0)::text AS quote FROM vault_reward_allocations WHERE plan_id=$1", [planId]);
      const allocatedQuote = BigInt(amounts[0]!.quote);
      // Quote can round to zero for every holder. Skip the round and carry both assets forward.
      if (quoteBudget === 0n || allocatedQuote === 0n) {
        stage = "skipped";
        await skipPeriod(tx, plan.period_id, "low-budget");
      } else if (!gasReserveFits(BigInt(f.reserve), allocatedQuote)) {
        throw new Error("Reward gas reserve exceeds a tenth of allocated holder Quote.");
      }
    }
    await tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET inputs=$2,stage=$3 WHERE plan_id=$1", [planId, json({ ...f, reserve: stage === "skipped" ? "0" : f.reserve, allocationCursor: last }), stage]);
    return complete;
  }, { isolationLevel: "REPEATABLE READ", retry: true });
}

/** A short repeatable-read arbitration: exact gross, current round, immutable upload, one reserved plan per vault. */
export async function reservePlan(pool: Pool, deployment: BlastDeployment, planId: string): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const { rows } = await tx.read<Plan>("SELECT * FROM vault_reward_plans WHERE plan_id=$1 FOR UPDATE", [planId]);
    const p = rows[0];
    if (!p || p.stage !== "uploaded" || !p.storage_verified_at || !p.storage_hash || !p.storage_url || !p.manifest) throw new Error("Reward plan is not durably uploaded.");
    const f = frozenSchema.parse(p.inputs);
    const manifest = validateRewardManifestSummary(p.manifest as Parameters<typeof validateRewardManifestSummary>[0]);
    if (manifest.quoteAmount === "0") throw new Error("Reward reservation requires a holder Quote payout.");
    if (!f.payoutPolicy) throw new MissingRewardHistory("reward-payout-policy-cutover");
    await tx.read("SELECT period_id FROM vault_reward_periods WHERE period_id=$1 FOR UPDATE", [p.period_id]);
    await tx.read("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${f.fingerprint}:${f.vaultId}`]);
    const unfunded = await tx.read("SELECT p.plan_id FROM vault_reward_plans p JOIN vault_reward_periods d USING(period_id) WHERE d.deployment_fingerprint=$1 AND d.vault_id=$2 AND p.plan_id<>$3 AND p.stage IN ('reserved','scheduled') LIMIT 1", [f.fingerprint, f.vaultId, planId]);
    if (unfunded.rowCount) throw new Error("Another reward plan reserves this vault.");
    const historical = await historicalFunds(tx, deployment, f.fingerprint, f.vaultId, f.end);
    const committed = await reservationsAtCut(tx, f.fingerprint, f.vaultId, f.end, planId);
    if (historical.meme - committed.meme !== BigInt(f.grossMeme) || historical.quote - committed.quote !== BigInt(f.grossQuote)) throw new Error("Reward gross budget changed before reservation.");
    const current = await completeCut(tx, f.fingerprint);
    const treasury = await historicalTreasury(tx, deployment, current);
    if (treasury.treasury !== f.treasury) throw new Error("Reward treasury changed before reservation.");
    const { rows: vaults } = await tx.read<{ next_round: string }>("SELECT next_round::text FROM chain_read_v1.vaults WHERE vault_id=$1", [f.vaultId]);
    if (vaults[0]?.next_round !== f.number) throw new Error("Reward round changed before reservation.");
    const { rows: sums } = await tx.read<{ count: string; proofs: string; meme: string; quote: string; hasTreasuryLeaf: boolean }>(
      `SELECT count(*)::text AS count, count(proof)::text AS proofs, coalesce(sum(meme_amount),0)::text AS meme, coalesce(sum(quote_amount),0)::text AS quote,
       coalesce(bool_or(beneficiary=$2),false) AS "hasTreasuryLeaf"
       FROM vault_reward_allocations WHERE plan_id=$1`, [planId, f.treasury]);
    const totals = sums[0]!;
    if (totals.hasTreasuryLeaf) throw new Error("Reward reservation cannot pay a holder reward to the treasury.");
    if (manifest.vaultId !== f.vaultId || manifest.number !== f.number || manifest.startCheckpoint !== f.roundStart || manifest.endCheckpoint !== f.end.checkpoint || Number(totals.count) !== manifest.leafCount || totals.proofs !== totals.count || totals.meme !== manifest.memeAmount || totals.quote !== manifest.quoteAmount || BigInt(totals.meme) > BigInt(f.grossMeme) || BigInt(totals.quote) + BigInt(f.reserve) > BigInt(f.grossQuote) || !gasReserveFits(BigInt(f.reserve), BigInt(totals.quote))) throw new Error("Reward reservation does not conserve its frozen assets and proved allocations.");
    const commitment = planCommitment(f, p.manifest, p.storage_hash);
    await tx.forModule("rewards-planner").write("vault_reward_plans", "UPDATE vault_reward_plans SET stage='reserved',inputs=$2 WHERE plan_id=$1", [planId, json({ ...f, commitment })]);
    await tx.forModule("rewards-planner").write("vault_reward_periods", "UPDATE vault_reward_periods SET status='reserved' WHERE period_id=$1", [p.period_id]);
  }, { isolationLevel: "REPEATABLE READ", retry: true });
}
