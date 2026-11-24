import type { Pool } from "pg";
import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import type { JobContext, ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import type { KeeperSigner } from "./signer.ts";

export const KEEPER_ACTIONS = "blast_keeper_actions";
export type KeeperActionKind = "presale" | "vault-fees" | "vault-partner" | "presale-partner";
export type KeeperContext = JobContext<ProtocolWorkerAccess, KeeperSigner>;
export type Candidate = Readonly<{
  object_id: string;
  meme_type: string;
  quote_type: string;
  origin_id?: string;
  origin_kind?: "launch" | "presale";
  package_witness?: string;
  venue_type?: string;
  pool_id?: string;
  pool_creation_id?: string | null;
  attempts: number;
}>;

const SOURCES: Readonly<Record<KeeperActionKind, string>> = {
  presale: `SELECT presale_id AS object_id,sale_token AS meme_type,quote_type,pool_creation_id
    FROM chain_read_v1.lifecycle_planning WHERE lifecycle IN ('open','funded')`,
  "presale-partner": `SELECT p.presale_id AS object_id,p.sale_token AS meme_type,p.quote_type
    FROM chain_read_v1.presales p WHERE p.lifecycle='migrated' AND p.partner_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM chain_read_v1.protocol_fee_ledgers l WHERE l.kind='presale'
      AND l.origin_id=p.presale_id AND l.meme_type=p.sale_token AND l.quote_type=p.quote_type
      AND (l.accrued_meme>l.treasury_paid_meme+l.partner_paid_meme
        OR l.accrued_quote>l.treasury_paid_quote+l.partner_paid_quote
        OR l.accrued_sui>l.treasury_paid_sui+l.partner_paid_sui))`,
  "vault-fees": `SELECT vault_id AS object_id,meme_type,quote_type,origin_id,origin_kind,package_witness,venue_type,pool_id
    FROM chain_read_v1.vaults`,
  "vault-partner": `SELECT v.vault_id AS object_id,v.meme_type,v.quote_type,v.origin_id,v.origin_kind,v.package_witness,v.venue_type,v.pool_id
    FROM chain_read_v1.vaults v WHERE EXISTS (SELECT 1 FROM chain_read_v1.protocol_fee_ledgers l
      WHERE l.kind='vault' AND l.origin_id=v.origin_id AND l.meme_type=v.meme_type AND l.quote_type=v.quote_type
      AND l.partner_id IS NOT NULL AND (l.accrued_meme>l.treasury_paid_meme+l.partner_paid_meme
        OR l.accrued_quote>l.treasury_paid_quote+l.partner_paid_quote
        OR l.accrued_sui>l.treasury_paid_sui+l.partner_paid_sui))`,
};

/** Oldest due first. Every attempted record advances, so a bad vault cannot starve later ones. */
export async function dueCandidates(context: KeeperContext, kind: KeeperActionKind): Promise<Candidate[]> {
  const { rows } = await autocommitRead<Candidate>(context.pool, "blast-keeper", `
    SELECT c.*,coalesce(r.attempts,0) AS attempts FROM (${SOURCES[kind]}) c
    LEFT JOIN blast_keeper_actions r ON r.network=$1 AND r.fingerprint=$2 AND r.kind=$3 AND r.object_id=c.object_id
    WHERE r.object_id IS NULL OR r.next_check_at <= now()
    ORDER BY coalesce(r.next_check_at,'-infinity'::timestamptz),c.object_id LIMIT $4`,
  [context.deployment.network, context.fingerprint, kind, context.config.batchSize]);
  return rows;
}

export async function recordDue(
  pool: Pool,
  scope: Readonly<{ network: string; fingerprint: string; kind: KeeperActionKind; objectId: string }>,
  delayMs: number,
  errorClass: string | null,
  digest: string | null = null,
  outcome: "failed" | "executed" | "unchanged" = "unchanged",
): Promise<void> {
  await autocommitWrite(pool, "blast-keeper", KEEPER_ACTIONS, `INSERT INTO blast_keeper_actions
    (network,fingerprint,kind,object_id,next_check_at,attempts,latest_digest,error_class,updated_at)
    VALUES ($1,$2,$3,$4,now()+$5*interval '1 millisecond',CASE WHEN $8='failed' THEN 1 ELSE 0 END,$6,$7,now())
    ON CONFLICT(network,fingerprint,kind,object_id) DO UPDATE SET
      next_check_at=excluded.next_check_at,attempts=CASE WHEN $8='failed' THEN blast_keeper_actions.attempts+1
        WHEN $8='executed' THEN 0 ELSE blast_keeper_actions.attempts END,
      latest_digest=coalesce(excluded.latest_digest,blast_keeper_actions.latest_digest),error_class=excluded.error_class,updated_at=now()`,
  [scope.network, scope.fingerprint, scope.kind, scope.objectId, delayMs, digest, errorClass, outcome]);
}
