import { BLAST_DEPLOYMENTS, BLAST_NETWORKS, defineBlastDeployment, launchpadDeployment, type BlastNetwork } from "@interest-protocol/blast-sdk/deployments";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { isLaunchClaimKind, type LaunchClaimKind } from "@blast/core/modules/social/contracts/launch-claims.ts";
import { settleLoggedTransaction, type TransactionSettlement } from "@blast/core/modules/social/transactions/log.ts";
import { readStepCursor, writeStepCursor, type SocialWorkerBounds, type SocialWorkerStep } from "../worker/steps.ts";
import { launchClaimBindingFromKey } from "@blast/core/modules/social/claims/identity.ts";
import { claimsBinding, launchClaimEvents, type LaunchClaimPackages } from "@blast/core/modules/social/claims/launch-events.ts";
import { sharedVestingExecution, VESTING_SHARED_EVIDENCE_SQL } from "./vesting.ts";

const STEP = "claim-launch-settle";
type Cursor = Readonly<{ created_at_ms: string; tx_id: string }>;
type Row = Cursor & Readonly<{ account_id: string; idempotency_key: string; kind: string; digest: string }>;
type Evidence = Readonly<{
  digest: string;
  checkpoint: string;
  timestamp_ms: string;
  sender: string;
  success: boolean;
  events: unknown;
  sender_own: boolean;
}>;

/** Keyset pages of sent launch claims, through 0136's partial index. */
export const LAUNCH_CLAIM_PAGE_SQL = `SELECT t.tx_id::text,t.created_at_ms::text,t.account_id::text,t.idempotency_key,t.kind,t.digest
  FROM social_transactions t
  WHERE t.state='submitted' AND t.kind IN ('claim_launch_fees','claim_launch_lp_fees') AND t.digest IS NOT NULL
    AND ($1::bigint IS NULL OR (t.created_at_ms,t.tx_id)>($1::bigint,$2::uuid))
  ORDER BY t.created_at_ms,t.tx_id LIMIT $3`;

const EVIDENCE_SQL = `SELECT e.*, EXISTS(SELECT 1 FROM social_wallet_owners o WHERE o.account_id=$4::uuid AND o.address=e.sender) AS sender_own
  FROM (${VESTING_SHARED_EVIDENCE_SQL}) e`;
assertChainReadThroughViews(EVIDENCE_SQL);

/** The released deployment's launchpad and vault packages on `BLAST_NETWORK`, or null when none is released. */
export function releasedLaunchClaimPackages(environment: Readonly<Record<string, string | undefined>> = process.env): LaunchClaimPackages | null {
  const network = environment.BLAST_NETWORK?.trim() as BlastNetwork | undefined;
  const input = network && BLAST_NETWORKS.includes(network) ? BLAST_DEPLOYMENTS[network] : undefined;
  if (!input) return null;
  const deployment = defineBlastDeployment(input);
  return {
    launchpad: launchpadDeployment(deployment).originalPackageId,
    vault: launchpadDeployment(deployment).vault.originalPackageId,
  };
}

/**
 * Settles a sent launch claim whose client never came back, from blast-infra's native evidence
 * for its exact digest (within the same coherent cut as the output transaction): `confirmed`
 * when a wallet of the row's account sent it, it succeeded, and it emitted the claim event for
 * the launch (or vault) the row's key binds; `failed` otherwise. A digest without evidence yet
 * waits; the claim expiry ends one that never reaches the chain.
 */
export function launchClaimStep(
  config: Readonly<{ batchSize: number; packages?: LaunchClaimPackages | null }>,
): SocialWorkerStep {
  const packages = config.packages === undefined ? releasedLaunchClaimPackages() : config.packages;
  return {
    name: STEP,
    pipeline: "presale",
    async run(tx: ModuleTransaction<"social">, bounds: SocialWorkerBounds | null) {
      if (!packages || !bounds) return {};
      const cursor = await readStepCursor<Cursor>(tx, STEP);
      const { rows } = await tx.read<Row>(LAUNCH_CLAIM_PAGE_SQL, [
        cursor?.created_at_ms ?? null,
        cursor?.tx_id ?? null,
        Math.min(16, config.batchSize),
      ]);
      let confirmed = 0,
        failed = 0;
      for (const row of rows) {
        const raw = (await tx.read<Evidence>(EVIDENCE_SQL, [[row.digest], bounds.checkpoint, bounds.timestampMs, row.account_id])).rows[0];
        const settlement = launchClaimSettlement(row, raw, packages);
        if (!settlement) continue;
        const outcome = await settleLoggedTransaction(tx, { accountId: row.account_id, idempotencyKey: row.idempotency_key }, settlement);
        if (outcome !== "settled") continue;
        if (settlement.state === "confirmed") confirmed++;
        else failed++;
      }
      const last = rows.at(-1);
      await writeStepCursor(tx, STEP, last ? { created_at_ms: last.created_at_ms, tx_id: last.tx_id } : null);
      return { claims_confirmed: confirmed, claims_failed: failed };
    },
  };
}

function launchClaimSettlement(row: Row, raw: Evidence | undefined, packages: LaunchClaimPackages): TransactionSettlement | null {
  if (!raw || !isLaunchClaimKind(row.kind)) return null;
  const binding = launchClaimBindingFromKey(row.kind, row.idempotency_key, row.tx_id);
  const execution = sharedVestingExecution(raw);
  if (!binding || !execution || execution.digest !== row.digest || execution.timestampMs === null || execution.timestampMs <= 0) return null;
  const kind: LaunchClaimKind = row.kind;
  const matched = raw.sender_own && claimsBinding(launchClaimEvents(execution.events, packages), kind, binding);
  if (execution.success && matched) return { state: "confirmed", digest: row.digest, settledAtMs: execution.timestampMs };
  return { state: "failed", failureCode: execution.success ? "mismatch" : "execution_failed", settledAtMs: execution.timestampMs };
}
