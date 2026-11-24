import { createHash } from "node:crypto";

import type { ModuleTransaction, ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { BlastWorkspaceAcknowledgement, BlastWorkspaceResponse, BlastWorkspaceWrite } from "@blast/core/modules/social/contracts/blast-workspace.ts";

type WorkspaceRow = { schema_version: number; workspace: BlastWorkspaceWrite["workspace"]; revision: string; saved_at_ms: string };
type WriterRow = { sequence: string; payload_fingerprint: string; accepted_revision: string; saved_at_ms: string };
const READ_WORKSPACE = "SELECT schema_version, workspace, revision::text, saved_at_ms::text FROM social_blast_workspaces WHERE account_id = $1";

export async function readBlastWorkspace(db: ReadableDatabase, accountId: string): Promise<BlastWorkspaceResponse> {
  const row = (await db.read<WorkspaceRow>(READ_WORKSPACE, [accountId])).rows[0];
  if (row && row.schema_version !== 1) throw new SocialRouteError("workspace_schema_unsupported");
  return { account_id: accountId, revision: row?.revision ?? "0", saved_at_ms: row ? Number(row.saved_at_ms) : null, workspace: row?.workspace ?? null };
}

/** Stable object-key order makes retries insensitive to JSON property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function saveBlastWorkspace(
  social: ModuleTransaction<"social">,
  accountId: string,
  write: BlastWorkspaceWrite,
): Promise<BlastWorkspaceAcknowledgement> {
  // This existing row is a lock target even when the account has never saved.
  const account = await social.read("SELECT account_id FROM social_accounts WHERE account_id = $1 FOR UPDATE", [accountId]);
  if (!account.rows.length) throw new SocialRouteError("account_required");
  const fingerprint = createHash("sha256").update(canonical(write)).digest("hex");
  const previous = (await social.read<WriterRow>(
    "SELECT sequence::text, payload_fingerprint, accepted_revision::text, saved_at_ms::text FROM social_blast_workspace_writers WHERE account_id = $1 AND writer_id = $2",
    [accountId, write.writer_id],
  )).rows[0];
  if (previous) {
    if (write.sequence < Number(previous.sequence)) throw new SocialRouteError("workspace_write_outdated");
    if (write.sequence === Number(previous.sequence)) {
      if (fingerprint !== previous.payload_fingerprint) throw new SocialRouteError("workspace_write_mismatch");
      return { account_id: accountId, sequence: write.sequence, revision: previous.accepted_revision, saved_at_ms: Number(previous.saved_at_ms) };
    }
  }

  const stored = (await social.read<WorkspaceRow>(READ_WORKSPACE, [accountId])).rows[0];
  if (stored && write.initialize_if_absent) throw new SocialRouteError("workspace_exists");
  if (stored && stored.schema_version > write.workspace.schema_version) throw new SocialRouteError("workspace_schema_unsupported");
  const row = (await social.write<WorkspaceRow>("social_blast_workspaces", `
    INSERT INTO social_blast_workspaces (account_id, schema_version, workspace, revision, saved_at_ms)
    VALUES ($1, $2, $3::jsonb, 1, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
    ON CONFLICT (account_id) DO UPDATE SET schema_version = EXCLUDED.schema_version,
      workspace = EXCLUDED.workspace, revision = social_blast_workspaces.revision + 1,
      saved_at_ms = EXCLUDED.saved_at_ms
    RETURNING revision::text, saved_at_ms::text`,
  [accountId, write.workspace.schema_version, JSON.stringify(write.workspace)])).rows[0]!;
  await social.write("social_blast_workspace_writers", `
    INSERT INTO social_blast_workspace_writers (account_id, writer_id, sequence, payload_fingerprint, accepted_revision, saved_at_ms)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (account_id, writer_id) DO UPDATE SET sequence = EXCLUDED.sequence,
      payload_fingerprint = EXCLUDED.payload_fingerprint, accepted_revision = EXCLUDED.accepted_revision,
      saved_at_ms = EXCLUDED.saved_at_ms`,
  [accountId, write.writer_id, write.sequence, fingerprint, row.revision, row.saved_at_ms]);
  return { account_id: accountId, sequence: write.sequence, revision: row.revision, saved_at_ms: Number(row.saved_at_ms) };
}
