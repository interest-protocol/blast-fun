import type { Pool } from "pg";

import type { AllowlistProof } from "@interest-protocol/blast-sdk/presale";

import { autocommitRead, withTransaction } from "@blast/core/modules/database/transaction.ts";
import type { AllowlistEntriesResponse, AllowlistResponse, AllowlistSource, AllowlistWarning } from "@blast/core/modules/presale/contracts/web-api.ts";

/** Who owns a manifest: a Privy account by DID, or an agent API key by id. */
export type AllowlistOwner = Readonly<{ kind: "account" | "api_key"; id: string }>;

export type NewAllowlist = Readonly<{
  id: string;
  owner: AllowlistOwner;
  quote: string;
  root: string;
  leafCount: bigint;
  totalCap: bigint;
  warnings: readonly AllowlistWarning[];
  source?: AllowlistSource;
  /** Every entry's proof, in index order. */
  proofs: readonly AllowlistProof[];
}>;

/** Entries per INSERT statement. */
export const ALLOWLIST_INSERT_BATCH = 1_000;

/**
 * One INSERT of up to `ALLOWLIST_INSERT_BATCH` entries. Each proof goes as a
 * `bytea[]` text literal built straight from the SDK's lowercase hex, which
 * spares a Buffer per node and pg's re-encoding of it back to hex.
 */
function entriesStatement(allowlistId: string, batch: readonly AllowlistProof[]): [string, unknown[]] {
  const values: unknown[] = [allowlistId];
  const rows = batch.map((entry) => {
    values.push(
      Number(entry.index),
      entry.wallet,
      entry.walletCap.toString(),
      `{${entry.proof.map((node) => `"\\\\x${node}"`).join(",")}}`,
    );
    const at = values.length;
    return `($1, $${at - 3}, $${at - 2}, $${at - 1}, $${at}::bytea[])`;
  });
  return [`INSERT INTO presale_allowlist_entries (allowlist_id, index, wallet, wallet_cap, proof) VALUES ${rows.join(", ")}`, values];
}

/**
 * Stores a manifest and all its entries with their proofs in one transaction
 * (migration 0041), at most 1,000 entries per statement: either all of it is
 * stored or none. The next statement is built while the database runs the
 * current one.
 */
export async function insertAllowlist(pool: Pool, allowlist: NewAllowlist): Promise<void> {
  await withTransaction(pool, async (transaction) => {
    const allowlists = transaction.forModule("presale-allowlists");
    await allowlists.write(
      "presale_allowlists",
      `INSERT INTO presale_allowlists
         (id, owner_kind, owner_id, quote, root, leaf_count, entry_count, total_cap, warnings, source)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)`,
      [
        allowlist.id,
        allowlist.owner.kind,
        allowlist.owner.id,
        allowlist.quote,
        allowlist.root,
        Number(allowlist.leafCount),
        allowlist.totalCap.toString(),
        JSON.stringify(allowlist.warnings),
        allowlist.source ? JSON.stringify(allowlist.source) : null,
      ],
    );
    const statement = (start: number) =>
      start < allowlist.proofs.length
        ? entriesStatement(allowlist.id, allowlist.proofs.slice(start, start + ALLOWLIST_INSERT_BATCH))
        : null;
    let next = statement(0);
    for (let start = 0; next; start += ALLOWLIST_INSERT_BATCH) {
      const running = allowlists.write("presale_allowlist_entries", ...next);
      next = statement(start + ALLOWLIST_INSERT_BATCH);
      await running;
    }
  }, { label: "presale.allowlist_create" });
}

type SummaryRow = {
  id: string;
  root: string;
  leaf_count: number;
  entry_count: number;
  total_cap: string;
  warnings: AllowlistWarning[];
};

/** The owner's manifest summary, or null for an unknown id or another owner's manifest. */
export async function findOwnedAllowlist(pool: Pool, id: string, owner: AllowlistOwner): Promise<AllowlistResponse | null> {
  const result = await autocommitRead<SummaryRow>(
    pool,
    "presale-allowlists",
    `SELECT id, root, leaf_count, entry_count, total_cap::text AS total_cap, warnings
     FROM presale_allowlists WHERE id = $1 AND owner_kind = $2 AND owner_id = $3`,
    [id, owner.kind, owner.id],
    { label: "presale.allowlist" },
  );
  const row = result.rows[0];
  return row
    ? {
        allowlist_id: row.id,
        root: row.root,
        leaf_count: `${BigInt(row.leaf_count)}`,
        entry_count: row.entry_count,
        total_cap: row.total_cap as `${bigint}`,
        warnings: row.warnings,
      }
    : null;
}

type CapRangeRow = { root: string; leaf_count: number; quote: string; min_cap: string | null; max_cap: string | null };

/**
 * The owner's manifest with the smallest and largest per-wallet cap (Quote
 * atoms, decimal text), or null for an unknown id or another owner's
 * manifest. Social Create (UI-20) shows them ("1,200 wallets, $100 to
 * $5,000 each") when a draft attaches the allowlist. One primary-key range
 * read of the manifest's entries.
 */
export async function findOwnedAllowlistCapRange(
  pool: Pool,
  id: string,
  owner: AllowlistOwner,
): Promise<Readonly<{ root: string; leafCount: number; minCap: bigint; maxCap: bigint; quote: string }> | null> {
  const result = await autocommitRead<CapRangeRow>(
    pool,
    "presale-allowlists",
    `SELECT a.root, a.leaf_count, a.quote, min(e.wallet_cap)::text AS min_cap, max(e.wallet_cap)::text AS max_cap
     FROM presale_allowlists a LEFT JOIN presale_allowlist_entries e ON e.allowlist_id = a.id
     WHERE a.id = $1 AND a.owner_kind = $2 AND a.owner_id = $3
     GROUP BY a.id`,
    [id, owner.kind, owner.id],
    { label: "presale.allowlist_cap_range" },
  );
  const row = result.rows[0];
  return row ? { root: row.root, leafCount: row.leaf_count, minCap: BigInt(row.min_cap ?? "0"), maxCap: BigInt(row.max_cap ?? "0"), quote: row.quote } : null;
}

/** The owner can recheck or download exactly the rows stored with the manifest. */
export async function findOwnedAllowlistEntries(pool: Pool, id: string, owner: AllowlistOwner): Promise<AllowlistEntriesResponse | null> {
  const result = await autocommitRead<{ quote: string; source: AllowlistSource | null; entries: AllowlistEntriesResponse["entries"] }>(
    pool, "presale-allowlists", `
      SELECT a.quote, a.source,
        jsonb_agg(jsonb_build_object('wallet', e.wallet, 'cap', e.wallet_cap::text) ORDER BY e.index) AS entries
      FROM presale_allowlists a JOIN presale_allowlist_entries e ON e.allowlist_id = a.id
      WHERE a.id = $1 AND a.owner_kind = $2 AND a.owner_id = $3 GROUP BY a.id
    `, [id, owner.kind, owner.id], { label: "presale.allowlist_entries" });
  return result.rows[0] ?? null;
}
