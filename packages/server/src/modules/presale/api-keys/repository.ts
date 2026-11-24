import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import type { AgentApiKeyVerifier } from "@blast/core/modules/presale/route-kit/contracts.ts";
import { generatePresaleApiKey, hashPresaleApiKey, isPresaleApiKey } from "./keys.ts";

/** A key as operators see it: never its secret or hash. `issuedBy`/`revokedBy` are `operator:<operator ID>`. */
export type PresaleApiKeySummary = Readonly<{
  id: string;
  label: string;
  issuedBy: string;
  createdAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
}>;

/** A newly issued key: `key` is the only copy of the raw key. */
export type IssuedPresaleApiKey = PresaleApiKeySummary & Readonly<{ key: string }>;

type Row = {
  id: string;
  label: string;
  issued_by: string;
  created_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
};

const COLUMNS = "id, label, issued_by, created_at, revoked_at, revoked_by";

function summary(row: Row): PresaleApiKeySummary {
  return {
    id: row.id,
    label: row.label,
    issuedBy: row.issued_by,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
  };
}

/** Issues a key under `label` for `issuedBy` (`operator:<id>`), storing only its SHA-256 (migration 0041). */
export async function issuePresaleApiKey(pool: Pool, label: string, issuedBy: string): Promise<IssuedPresaleApiKey> {
  const key = generatePresaleApiKey();
  const result = await autocommitWrite<"presale-api-keys", Row>(
    pool,
    "presale-api-keys",
    "presale_api_keys",
    `INSERT INTO presale_api_keys (id, label, key_hash, issued_by) VALUES ($1, $2, $3, $4)
     RETURNING ${COLUMNS}`,
    [randomUUID(), label, hashPresaleApiKey(key), issuedBy],
  );
  return { ...summary(result.rows[0]), key };
}

/**
 * Revokes a key as `revokedBy` (`operator:<id>`). Revoking it again keeps the
 * first time and operator. Null for an unknown id.
 */
export async function revokePresaleApiKey(pool: Pool, id: string, revokedBy: string): Promise<PresaleApiKeySummary | null> {
  const result = await autocommitWrite<"presale-api-keys", Row>(
    pool,
    "presale-api-keys",
    "presale_api_keys",
    `UPDATE presale_api_keys
     SET revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $2)
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, revokedBy],
  );
  return result.rows[0] ? summary(result.rows[0]) : null;
}

/** Every key, oldest first, without secrets. */
export async function listPresaleApiKeys(pool: Pool): Promise<PresaleApiKeySummary[]> {
  const result = await autocommitRead<Row>(
    pool,
    "presale-api-keys",
    `SELECT ${COLUMNS} FROM presale_api_keys ORDER BY created_at, id`,
  );
  return result.rows.map(summary);
}

/** How long a key the database did not know is refused without asking it again. */
export const PRESALE_API_KEY_MISS_TTL_MS = 60_000;
/** The most refused keys remembered per instance; the oldest are forgotten first. */
export const PRESALE_API_KEY_MISS_ENTRIES = 10_000;

/**
 * The route kit's `verifyApiKey` port: an active key gives its id as the
 * principal (`did` null: a key belongs to no Privy account). A value without
 * a key's shape is refused before any read; an unknown or revoked key is null.
 * `pool` is resolved per call, so a missing database setting fails only the
 * request (`service_unavailable`).
 *
 * A miss (unknown or revoked) is remembered for `PRESALE_API_KEY_MISS_TTL_MS`
 * in this instance (review M2), so the same wrong key repeated costs one read
 * a minute. Only misses are kept: a revocation still takes effect on the next
 * request, and a newly issued key, which nobody could have guessed, is never
 * refused from memory.
 */
export function createPresaleApiKeyVerifier(
  pool: () => Pool,
  options: Readonly<{ now?: () => number; missTtlMs?: number; missEntries?: number }> = {},
): AgentApiKeyVerifier {
  const now = options.now ?? Date.now;
  const ttl = options.missTtlMs ?? PRESALE_API_KEY_MISS_TTL_MS;
  const capacity = options.missEntries ?? PRESALE_API_KEY_MISS_ENTRIES;
  /** Key hash → when the miss is forgotten; insertion order is age order. */
  const misses = new Map<string, number>();
  return async (value) => {
    if (!isPresaleApiKey(value)) return null;
    const hash = hashPresaleApiKey(value);
    const missKey = hash.toString("base64");
    const until = misses.get(missKey);
    if (until !== undefined) {
      if (until > now()) return null;
      misses.delete(missKey);
    }
    const result = await autocommitRead<{ id: string }>(
      pool(),
      "presale-api-keys",
      "SELECT id FROM presale_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
      [hash],
      { label: "presale.api_key" },
    );
    const id = result.rows[0]?.id;
    if (id) return { keyId: id, did: null };
    misses.set(missKey, now() + ttl);
    while (misses.size > capacity) misses.delete(misses.keys().next().value!);
    return null;
  };
}
