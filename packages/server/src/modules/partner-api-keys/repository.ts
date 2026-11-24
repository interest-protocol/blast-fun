import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { configuredPartnerRecognition } from "./recognition.ts";
import { PARTNER_STANDARD_LIMITS } from "@blast/core/lib/web-security/rate-limits.ts";
import { autocommitRead, batchedRead } from "@blast/core/modules/database/transaction.ts";
import { PARTNER_VERIFIER_POOL_SETTINGS, partnerVerifierPool } from "@blast/core/modules/database/pool.ts";
import {
  generatePartnerApiKey, hashPartnerApiKey, isPartnerApiKey,
  partnerSchema, partnerGrantSchema, partnerKeyPolicySchema,
  type Partner, type PartnerGrant, type PartnerKeyReader, type PartnerKeyPolicy,
} from "@blast/server/modules/partner-api-keys/contracts.ts";

export type PartnerKeySummary = Readonly<{
  id: string; partner_id: string; label: string; issued_by: string;
  created_at: Date; revoked_at: Date | null; revoked_by: string | null;
  tier: PartnerKeyPolicy["tier"]; requests_per_minute: number | null; requests_per_day: number | null;
  policy_updated_at: Date; policy_updated_by: string;
}>;
export type PartnerSummary = Partner & Readonly<{
  created_at: Date; created_by: string; updated_at: Date; updated_by: string;
}>;
const KEY_COLUMNS = "id, partner_id, label, issued_by, created_at, revoked_at, revoked_by, tier, requests_per_minute, requests_per_day, policy_updated_at, policy_updated_by";
const PARTNER_COLUMNS = "id, origins, created_at, created_by, updated_at, updated_by";
const KEY_READ_TIMEOUTS = { ...PARTNER_VERIFIER_POOL_SETTINGS, lockTimeoutMs: 100 };

/**
 * pool must be the primary. No positive/negative cache or replica is used.
 * Simple-query batches cannot bind parameters; only hex-encoded bytes enter SQL.
 */
export function createPartnerKeyReader(pool: () => Pool): PartnerKeyReader {
  return {
    async verify(key) {
      if (!isPartnerApiKey(key)) return null;
      const result = await batchedRead<PartnerGrant>(pool(), "partner-api-keys",
        `SELECT p.id, p.origins, k.id AS "keyId",
           CASE WHEN k.tier = 'custom' THEN jsonb_build_object(
             'tier', k.tier, 'requestsPerMinute', k.requests_per_minute, 'requestsPerDay', k.requests_per_day)
           ELSE jsonb_build_object('tier', k.tier) END AS policy
         FROM partner_api_keys k
         JOIN partner_api_partners p ON p.id = k.partner_id
         WHERE k.key_hash = decode('${hashPartnerApiKey(key).toString("hex")}', 'hex') AND k.revoked_at IS NULL`,
        { label: "partner.api_key", timeouts: KEY_READ_TIMEOUTS });
      return result.rows[0] ? partnerGrantSchema.parse(result.rows[0]) : null;
    },
    async allowsOrigin(origin) {
      const result = await batchedRead(pool(), "partner-api-keys",
        `SELECT 1 FROM partner_api_partners p
         WHERE p.origins @> ARRAY[convert_from(decode('${Buffer.from(origin, "utf8").toString("hex")}', 'hex'), 'UTF8')]::text[]
           AND EXISTS (SELECT 1 FROM partner_api_keys k WHERE k.partner_id = p.id AND k.revoked_at IS NULL AND k.tier <> 'internal')
         LIMIT 1`, { label: "partner.preflight", timeouts: KEY_READ_TIMEOUTS });
      return result.rows.length > 0;
    },
  };
}

// Resolve lazily, but always select the primary even if a read replica is set.
export const partnerKeyReader = createPartnerKeyReader(partnerVerifierPool);

export async function createPartner(pool: Pool, partner: Partner, by: string): Promise<PartnerSummary> {
  const input = partnerSchema.parse(partner);
  const result = await configuredPartnerRecognition(pool).write((transaction) => transaction.forModule("partner-api-keys").write<PartnerSummary>("partner_api_partners",
    `INSERT INTO partner_api_partners (id, origins, created_by, updated_by) VALUES ($1, $2, $3, $3)
     RETURNING ${PARTNER_COLUMNS}`, [input.id, input.origins, by]));
  return result.rows[0];
}

export async function setPartnerOrigins(pool: Pool, partner: Partner, by: string): Promise<PartnerSummary | null> {
  const input = partnerSchema.parse(partner);
  const result = await configuredPartnerRecognition(pool).write((transaction) => transaction.forModule("partner-api-keys").write<PartnerSummary>("partner_api_partners",
    `UPDATE partner_api_partners SET origins = $2, updated_at = now(), updated_by = $3
     WHERE id = $1 RETURNING ${PARTNER_COLUMNS}`, [input.id, input.origins, by]));
  return result.rows[0] ?? null;
}

/** Raw key is returned once, never written into a row or included in list output. */
export async function issuePartnerApiKey(pool: Pool, partnerId: string, label: string, by: string): Promise<PartnerKeySummary & { key: string }> {
  const key = generatePartnerApiKey();
  const result = await configuredPartnerRecognition(pool).write((transaction) => transaction.forModule("partner-api-keys").write<PartnerKeySummary>("partner_api_keys",
    `INSERT INTO partner_api_keys (id, partner_id, label, key_hash, issued_by) VALUES ($1, $2, $3, $4, $5)
     RETURNING ${KEY_COLUMNS}`, [randomUUID(), partnerId, label, hashPartnerApiKey(key), by]));
  return { ...result.rows[0], key };
}

/** Coordinated publication and COMMIT finish before success; repeat revokes retain the first audit. */
export async function revokePartnerApiKey(pool: Pool, id: string, by: string): Promise<PartnerKeySummary | null> {
  const result = await configuredPartnerRecognition(pool).write((transaction) => transaction.forModule("partner-api-keys").write<PartnerKeySummary>("partner_api_keys",
    `UPDATE partner_api_keys SET revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $2)
     WHERE id = $1 RETURNING ${KEY_COLUMNS}`, [id, by]));
  return result.rows[0] ?? null;
}

/** Operator-only policy changes preserve the key's existing quota counters. */
export async function setPartnerKeyPolicy(pool: Pool, id: string, policy: PartnerKeyPolicy, by: string): Promise<PartnerKeySummary | null> {
  const input = partnerKeyPolicySchema.parse(policy);
  const minute = input.tier === "internal" ? null : input.tier === "standard" ? PARTNER_STANDARD_LIMITS.requestsPerMinute : input.requestsPerMinute;
  const day = input.tier === "internal" ? null : input.tier === "standard" ? PARTNER_STANDARD_LIMITS.requestsPerDay : input.requestsPerDay;
  const result = await configuredPartnerRecognition(pool).write((transaction) => transaction.forModule("partner-api-keys").write<PartnerKeySummary>("partner_api_keys",
    `UPDATE partner_api_keys SET tier = $2, requests_per_minute = $3, requests_per_day = $4,
       policy_updated_by = $5
     WHERE id = $1 AND revoked_at IS NULL RETURNING ${KEY_COLUMNS}`, [id, input.tier, minute, day, by]));
  return result.rows[0] ?? null;
}

export async function listPartnerApiKeys(pool: Pool): Promise<{ partners: PartnerSummary[]; keys: PartnerKeySummary[] }> {
  const [partners, keys] = await Promise.all([
    autocommitRead<PartnerSummary>(pool, "partner-api-keys", `SELECT ${PARTNER_COLUMNS} FROM partner_api_partners ORDER BY id`),
    autocommitRead<PartnerKeySummary>(pool, "partner-api-keys", `SELECT ${KEY_COLUMNS} FROM partner_api_keys ORDER BY created_at, id`),
  ]);
  return { partners: partners.rows, keys: keys.rows };
}

export async function deleteRevokedPartnerKey(pool: Pool, id: string, by: string): Promise<boolean> {
  const result = await configuredPartnerRecognition(pool).write((transaction) => transaction.forModule("partner-api-keys").read<{ deleted: boolean }>(
    "SELECT public.partner_delete_revoked_key($1::uuid, $2) AS deleted", [id, by]));
  return result.rows[0].deleted;
}

export async function deleteInactivePartnerGroup(pool: Pool, id: string, by: string): Promise<boolean> {
  const result = await configuredPartnerRecognition(pool).write((transaction) => transaction.forModule("partner-api-keys").read<{ deleted: boolean }>(
    "SELECT public.partner_delete_inactive_group($1, $2) AS deleted", [id, by]));
  return result.rows[0].deleted;
}
