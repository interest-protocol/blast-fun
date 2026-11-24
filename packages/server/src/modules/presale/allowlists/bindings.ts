import type { Pool } from "pg";

import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import type { AllowlistProofResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import type { AllowlistOwner } from "./repository.ts";

/** Who bound a sale: the manifest's owner through the bind route, or the proof route's auto-bind. */
export type AllowlistBinder = AllowlistOwner | "proof_route";

/**
 * Binds `presaleId` to a manifest (migration 0047). The first binding is
 * final: a sale already bound keeps its manifest and this changes nothing.
 * True when this call inserted the binding.
 */
export async function bindAllowlist(
  pool: Pool,
  binding: Readonly<{ presaleId: string; allowlistId: string; boundBy: AllowlistBinder }>,
): Promise<boolean> {
  const boundBy = binding.boundBy === "proof_route" ? binding.boundBy : `${binding.boundBy.kind}:${binding.boundBy.id}`;
  const result = await autocommitWrite(
    pool,
    "presale-allowlist-bindings",
    "presale_allowlist_bindings",
    `INSERT INTO presale_allowlist_bindings (presale_id, allowlist_id, bound_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (presale_id) DO NOTHING`,
    [binding.presaleId, binding.allowlistId, boundBy],
  );
  return result.rowCount === 1;
}

/** The earliest stored manifest with this root and leaf count, or null. */
export async function findAllowlistByRoot(pool: Pool, root: string, leafCount: bigint): Promise<string | null> {
  // No manifest holds more than 65,536 leaves, so a larger on-chain count matches nothing.
  if (leafCount > 65_536n) return null;
  const result = await autocommitRead<{ id: string }>(
    pool,
    "presale-allowlists",
    `SELECT id FROM presale_allowlists WHERE root = $1 AND leaf_count = $2 ORDER BY created_at, id LIMIT 1`,
    [root, Number(leafCount)],
    { label: "presale.allowlist_by_root" },
  );
  return result.rows[0]?.id ?? null;
}

type BoundEntryRow = { index: number | null; wallet_cap: string | null; proof: string[] | null };

/**
 * `wallet`'s proof from the manifest bound to `presaleId`: undefined when the
 * sale is not bound, null when it is but the wallet is not listed. Proof
 * entries are lowercase hex, leaf to root, as the SDK built them.
 */
export async function findBoundProof(
  pool: Pool,
  presaleId: string,
  wallet: string,
): Promise<AllowlistProofResponse | null | undefined> {
  const result = await autocommitRead<BoundEntryRow>(
    pool,
    "presale-allowlist-bindings",
    `SELECT entry.index, entry.wallet_cap::text AS wallet_cap,
            ARRAY(SELECT encode(node, 'hex') FROM unnest(entry.proof) WITH ORDINALITY AS path (node, position) ORDER BY position) AS proof
     FROM presale_allowlist_bindings AS binding
     LEFT JOIN presale_allowlist_entries AS entry ON entry.allowlist_id = binding.allowlist_id AND entry.wallet = $2
     WHERE binding.presale_id = $1`,
    [presaleId, wallet],
    { label: "presale.allowlist_proof" },
  );
  const row = result.rows[0];
  if (!row) return undefined;
  if (row.index === null || row.wallet_cap === null || row.proof === null) return null;
  return { index: `${BigInt(row.index)}`, wallet_cap: row.wallet_cap as `${bigint}`, proof: row.proof };
}

/** Canonical rows for a bound sale, or a manifest matching its verified eligibility. */
export async function findAllowlistCsv(
  pool: Pool,
  presaleId: string,
  eligibility?: Readonly<{ root: string; leafCount: bigint }>,
): Promise<string | null> {
  const result = await autocommitRead<{ csv: string | null }>(
    pool,
    "presale-allowlist-bindings",
    `SELECT string_agg(wallet || ',' || wallet_cap::text, E'\\r\\n' ORDER BY index) AS csv
     FROM presale_allowlist_entries
     WHERE allowlist_id = COALESCE(
       (SELECT allowlist_id FROM presale_allowlist_bindings WHERE presale_id = $1),
       (SELECT id FROM presale_allowlists WHERE root = $2 AND leaf_count = $3 ORDER BY created_at, id LIMIT 1)
     )`,
    [presaleId, eligibility?.root ?? null, eligibility?.leafCount.toString() ?? null],
    { label: "presale.allowlist_csv" },
  );
  return result.rows[0]?.csv ?? null;
}
