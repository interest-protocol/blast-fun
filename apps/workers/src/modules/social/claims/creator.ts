import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ModuleTransaction } from "@blast/core/modules/database/transaction.ts";
import { readPresaleDeploymentIdentity } from "@blast/core/modules/presale/deployment/service.ts";
import type { CreatorActionKind } from "@blast/core/modules/social/contracts/creator-earnings.ts";
import { settleLoggedTransaction, type TransactionSettlement } from "@blast/core/modules/social/transactions/log.ts";
import {
  readStepCursor,
  writeStepCursor,
  type SocialWorkerBounds,
  type SocialWorkerStep,
} from "../worker/steps.ts";
import { creatorEvents } from "@blast/core/modules/social/claims/creator-events.ts";
import { creatorVaultFromClaimKey } from "@blast/core/modules/social/claims/identity.ts";
import { sharedVestingExecution, VESTING_SHARED_EVIDENCE_SQL } from "./vesting.ts";

const STEP = "claim-creator-settle";
type Cursor = Readonly<{ created_at_ms: string; tx_id: string }>;
type Row = Cursor &
  Readonly<{
    account_id: string;
    idempotency_key: string;
    kind: CreatorActionKind;
    digest: string;
    presale_id: string;
    vault_presale_id: string | null;
  }>;
type Evidence = Readonly<{
  digest: string;
  checkpoint: string;
  timestamp_ms: string;
  sender: string;
  success: boolean;
  events: unknown;
  sender_own: boolean;
}>;

export const CREATOR_CLAIM_PAGE_SQL = `SELECT t.tx_id::text,t.created_at_ms::text,t.account_id::text,t.idempotency_key,t.kind,t.digest,t.presale_id,v.origin_id AS vault_presale_id
  FROM social_transactions t LEFT JOIN chain_read_v1.vaults v ON v.vault_id=right(t.idempotency_key,66) AND v.origin_kind='presale'
  WHERE t.state='submitted' AND t.kind IN ('collect_fees','claim_residuals') AND t.digest IS NOT NULL
    AND ($1::bigint IS NULL OR (t.created_at_ms,t.tx_id)>($1::bigint,$2::uuid))
  ORDER BY t.created_at_ms,t.tx_id LIMIT $3`;
assertChainReadThroughViews(CREATOR_CLAIM_PAGE_SQL);

const EVIDENCE_SQL = `SELECT e.*, EXISTS(SELECT 1 FROM social_wallet_owners o WHERE o.account_id=$4::uuid AND o.address=e.sender) AS sender_own
  FROM (${VESTING_SHARED_EVIDENCE_SQL}) e`;
assertChainReadThroughViews(EVIDENCE_SQL);

/** Exact digest, sender, vault and pinned event evidence survives a closed browser. */
export function creatorClaimStep(
  config: Readonly<{ batchSize: number; originalPackageId?: string }>,
): SocialWorkerStep {
  const deployment = readPresaleDeploymentIdentity();
  const original =
    config.originalPackageId ??
    (deployment.status === "ready" && deployment.identity.network === "mainnet"
      ? deployment.identity.presale.vault.originalPackageId
      : null);
  return {
    name: STEP,
    pipeline: "presale",
    async run(tx: ModuleTransaction<"social">, bounds: SocialWorkerBounds | null) {
      if (!original || !bounds) return {};
      const cursor = await readStepCursor<Cursor>(tx, STEP);
      const { rows } = await tx.read<Row>(CREATOR_CLAIM_PAGE_SQL, [
        cursor?.created_at_ms ?? null,
        cursor?.tx_id ?? null,
        Math.min(16, config.batchSize),
      ]);
      let confirmed = 0,
        failed = 0;
      for (const row of rows) {
        const vaultId = creatorVaultFromClaimKey(row.kind, row.idempotency_key, row.tx_id);
        if (!vaultId || row.vault_presale_id === null) continue;
        const raw = (
          await tx.read<Evidence>(EVIDENCE_SQL, [
            [row.digest],
            bounds.checkpoint,
            bounds.timestampMs,
            row.account_id,
          ])
        ).rows[0];
        const settlement = creatorSettlement(row, vaultId, raw, original);
        if (!settlement) continue;
        const outcome = await settleLoggedTransaction(
          tx,
          { accountId: row.account_id, idempotencyKey: row.idempotency_key },
          settlement,
        );
        if (outcome !== "settled") continue;
        if (settlement.state === "confirmed") confirmed++;
        else failed++;
      }
      const last = rows.at(-1);
      await writeStepCursor(
        tx,
        STEP,
        last ? { created_at_ms: last.created_at_ms, tx_id: last.tx_id } : null,
      );
      return { claims_confirmed: confirmed, claims_failed: failed };
    },
  };
}

function creatorSettlement(
  row: Row,
  vaultId: string,
  raw: Evidence | undefined,
  original: string,
): TransactionSettlement | null {
  if (!raw) return null;
  const execution = sharedVestingExecution(raw);
  if (
    !execution ||
    execution.digest !== row.digest ||
    execution.timestampMs === null ||
    execution.timestampMs <= 0
  )
    return null;
  const matched =
    raw.sender_own &&
    row.vault_presale_id === row.presale_id &&
    creatorEvents(execution.events, original).some(
      (event) => event.vaultId === vaultId && event.kind === row.kind,
    );
  if (execution.success && matched)
    return { state: "confirmed", digest: row.digest, settledAtMs: execution.timestampMs };
  return {
    state: "failed",
    failureCode: execution.success ? "mismatch" : "execution_failed",
    settledAtMs: execution.timestampMs,
  };
}
