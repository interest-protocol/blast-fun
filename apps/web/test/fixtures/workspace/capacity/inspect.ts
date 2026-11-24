import { createHash } from "node:crypto";
import { createPool } from "@blast/core/modules/database/pool.ts";
import { CHAIN_FIXTURE_VIEWS } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { syncFixtureConfiguration } from "../sync/configuration.ts";
import { canonical } from "./workload.ts";

const { url } = syncFixtureConfiguration();
const pool = createPool(url, { max: 1 });
const sha256 = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
try {
  const configuration = (
    await pool.query(
      "SELECT current_database() AS database, version() AS version, current_setting('max_connections')::int AS max_connections",
    )
  ).rows[0];
  const migrations = (
    await pool.query(
      "SELECT * FROM mission_control_schema_migrations ORDER BY name",
    )
  ).rows;
  const counts = (
    await pool.query(
      "SELECT (SELECT count(*)::int FROM social_accounts) AS accounts, (SELECT count(*)::int FROM social_blast_workspaces) AS workspaces, (SELECT count(*)::int FROM social_blast_workspace_writers) AS replay_rows, (SELECT coalesce(sum(revision),0)::int FROM social_blast_workspaces) AS accepted_writes",
    )
  ).rows[0];
  if (
    counts.accounts > 32 ||
    counts.workspaces > 32 ||
    counts.replay_rows > 512 ||
    counts.accepted_writes > 128 ||
    configuration.max_connections !== 40
  ) {
    throw new Error("Assigned focused fixture ceiling violated");
  }
  const rows = (
    await pool.query(
      "SELECT *, pg_column_size(workspace) AS stored_value_bytes, octet_length(workspace::text) AS jsonb_text_bytes FROM social_blast_workspaces ORDER BY account_id",
    )
  ).rows;
  const writers = (
    await pool.query(
      "SELECT * FROM social_blast_workspace_writers ORDER BY account_id, writer_id",
    )
  ).rows;
  const marketCounts: Record<string, number> = {};
  for (const view of CHAIN_FIXTURE_VIEWS) {
    marketCounts[view] = (
      await pool.query(`SELECT count(*)::int AS count FROM ${view}`)
    ).rows[0].count;
  }
  console.log(
    JSON.stringify(
      {
        configuration,
        migration_count: migrations.length,
        migration_sha256: sha256(migrations),
        counts,
        market_counts: marketCounts,
        workspace_rows_sha256: sha256(rows),
        writer_rows_sha256: sha256(writers),
        workspaces: rows.map((row) => ({
          account: Number.parseInt(row.account_id.slice(-12), 16),
          revision: row.revision,
          saved_at_ms: row.saved_at_ms,
          snapshot_sha256: sha256(row.workspace),
          stored_value_bytes: row.stored_value_bytes,
          jsonb_text_bytes: row.jsonb_text_bytes,
          visible: row.workspace.visible_order.length,
          retained: row.workspace.retained_order.length,
        })),
        relation_bytes: (
          await pool.query(
            "SELECT pg_total_relation_size('social_blast_workspaces')::int AS workspaces, pg_total_relation_size('social_blast_workspace_writers')::int AS replay",
          )
        ).rows[0],
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
