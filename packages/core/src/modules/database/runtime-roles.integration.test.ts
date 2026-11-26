import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { Pool } from "pg";

import { migrateDatabase } from "./migrations.ts";
import { createPool, createRuntimePool } from "./pool.ts";
import { withTransaction } from "./transaction.ts";
import { CHAIN_FIXTURE, ROLES, resetSharedDatabase, urlAs, type Role } from "../../../test/fixtures/modules/database/role-fixtures.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

/** The operational worker's tables (migrations 0035, 0038, 0137) and the only privileges `blast_watcher` holds on each. */
const WATCHER_TABLE_PRIVILEGES: Readonly<Record<string, string>> = {
  mission_control_worker_leases: "DELETE,INSERT,SELECT,UPDATE",
  mission_control_worker_jobs: "INSERT,SELECT,UPDATE",
  mission_control_worker_submissions: "INSERT,SELECT,UPDATE",
  mission_control_coin_registrations: "INSERT,SELECT,UPDATE",
  mission_control_launch_migrations: "INSERT,SELECT,UPDATE",
  mission_control_opening_rounds: "INSERT,SELECT,UPDATE",
  mission_control_fee_claims: "INSERT,SELECT,UPDATE",
  // LP-22 (0139): the buyback schedule is the watcher's alone.
  mission_control_launchpad_buybacks: "INSERT,SELECT,UPDATE",
  mission_control_vault_buybacks: "INSERT,SELECT,UPDATE",
};
/**
 * The launchpad's social tables (migration 0036) and every table-level grant
 * on each: the web runtime writes through the mutation guard, the replica
 * reads the public thesis and search joins (never an author's identity), and
 * no role may delete an author, a thesis or a moderation action. A thesis's only updatable columns are its
 * visibility (column grants, checked below).
 */
const SOCIAL_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  mission_control_launchpad_social_authors: ["blast_web:INSERT,SELECT"],
  mission_control_launchpad_theses: ["blast_replica:SELECT", "blast_web:INSERT,SELECT"],
  mission_control_launchpad_thesis_moderation: ["blast_web:INSERT,SELECT"],
  mission_control_launchpad_search_documents: ["blast_replica:SELECT", "blast_web:DELETE,INSERT,SELECT"],
};
/**
 * Launchpad outcome commitments (0037) are web-only and never updated.
 * The bonding banner pins (0149) is managed by web operators and read by
 * the replica; no worker role touches it.
 */
const LAUNCHPAD_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  mission_control_bonding_feature: ["blast_replica:SELECT", "blast_web:DELETE,INSERT,SELECT"],
  mission_control_launchpad_outcome_commitments: ["blast_web:DELETE,INSERT,SELECT"],
};
/**
 * The presale tables (`presale_` prefix, migration 0039 on): every table-level
 * grant on each. The embedded wallet cache, the allowlist manifests and their
 * entries (0041) are read and inserted by the web runtime only; nobody updates
 * or deletes a row. An API key's only updatable columns are `revoked_at` and
 * `revoked_by` (column grants, checked below). The presale workers (0040)
 * read the release gate, which only its owner (the migration login) writes,
 * and keep their alert state; the web runtime touches neither. Presale
 * outcomes (0043) are the web runtime's alone: an outcome's links are its only
 * updatable columns, the maintenance cleanup deletes outcomes after the
 * retention, and commitments are inserted and deleted. Account settings (0045)
 * are read, inserted and replaced by the web runtime; nobody deletes a row.
 * The bridge's transfers and activation records (0044) are the web runtime's
 * to insert and read; the relayer worker reads both and updates only a
 * transfer's progress columns (column grants, checked below). Nobody deletes
 * either, so history stays.
 * Sponsor reservations (0042) are inserted by the sponsor route and updated
 * by execute, never deleted; the worker host reads the hourly refusal counts
 * for its alert.
 * Receipt image catalog rows (0046) are read and inserted by the web runtime;
 * a row never changes and nobody deletes one.
 * The lifecycle relayer's records (0048) are the watcher's alone: inserted
 * and updated, never deleted, so a closed sale keeps its outcome. Claim
 * delivery's columns and `delivered` state (0050) change no grant.
 */
const PRESALE_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  presale_bridge_activations: ["blast_watcher:SELECT", "blast_web:INSERT,SELECT"],
  presale_bridge_transfers: ["blast_watcher:SELECT", "blast_web:INSERT,SELECT"],
  // Shared ingestion/outbox (0105-0107): planners own monetary facts; workers only read them.
  presale_outbox_actions: ["blast_indexer:INSERT,SELECT", "blast_watcher:INSERT,SELECT,UPDATE"],
  presale_outbox_attempts: ["blast_watcher:INSERT,SELECT,UPDATE"],
  presale_outbox_prepared_inputs: ["blast_watcher:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"],
  presale_outbox_input_objects: ["blast_watcher:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"],
  presale_outbox_input_reservations: ["blast_watcher:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"],
  presale_daily_vaults: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_daily_periods: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_daily_plans: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_coin_metadata: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE"],
  presale_daily_allocations: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_daily_hashes: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_quote_reservations: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_daily_executions: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_daily_gas_prices: ["blast_indexer:DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE", "blast_watcher:SELECT"],
  presale_daily_deliveries: ["blast_indexer:INSERT,SELECT", "blast_watcher:INSERT,SELECT,UPDATE"],
  presale_daily_round_status: ["blast_indexer:INSERT,SELECT", "blast_watcher:INSERT,SELECT,UPDATE"],
  presale_daily_gas_effects: ["blast_indexer:SELECT", "blast_watcher:INSERT,SELECT"],
  // Social feed (0054): the watcher and the replica read it as a source of `social_wallet_owners`.
  presale_embedded_wallets: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:INSERT,SELECT"],
  presale_release_gate_checks: ["blast_watcher:SELECT"],

  presale_api_keys: ["blast_web:INSERT,SELECT"],
  presale_allowlists: ["blast_web:INSERT,SELECT"],
  presale_allowlist_entries: ["blast_web:INSERT,SELECT"],
  presale_outcome_commitments: ["blast_web:DELETE,INSERT,SELECT"],
  presale_outcomes: ["blast_web:DELETE,INSERT,SELECT"],
  presale_account_settings: ["blast_web:INSERT,SELECT,UPDATE"],
  presale_sponsor_refusal_counts: ["blast_watcher:SELECT", "blast_web:INSERT,SELECT,UPDATE"],
  presale_sponsor_reservations: ["blast_web:INSERT,SELECT,UPDATE"],
  presale_sponsor_budget_attempts: ["blast_web:INSERT,SELECT,UPDATE"],
  presale_receipt_images: ["blast_web:INSERT,SELECT"],
  // Allowlist bindings (0047): the bind and proof routes insert and read; the first binding is final.
  presale_allowlist_bindings: ["blast_web:INSERT,SELECT"],
  presale_lifecycle_records: ["blast_watcher:INSERT,SELECT,UPDATE"],
  // Holder ledgers (0049): the rewards worker's alone; it writes each ledger and its watermark together.
  presale_reward_blacklists: ["blast_indexer:SELECT", "blast_web:INSERT,SELECT,UPDATE"],
  presale_reward_fee_destinations: ["blast_watcher:DELETE,INSERT,SELECT,UPDATE"],
  presale_reward_fee_policies: ["blast_watcher:DELETE,INSERT,SELECT,UPDATE"],
  presale_reward_ledger_accounts: ["blast_watcher:DELETE,INSERT,SELECT,UPDATE"],
  presale_reward_ledgers: ["blast_watcher:DELETE,INSERT,SELECT,UPDATE"],
  // Holder-reward rounds (0052): the workers' slots and rounds; allocations are inserted once and never change;
  // the web's manifest and wallet reward routes read rounds and allocations.
  presale_reward_allocations: ["blast_watcher:INSERT,SELECT", "blast_web:SELECT"],
  presale_reward_chain_rounds: ["blast_watcher:INSERT,SELECT,UPDATE"],
  presale_reward_event_cursors: ["blast_watcher:INSERT,SELECT,UPDATE"],
  // Q-013: a round's header (interval, root, digest, leaves, amounts) never changes after it is stored: column-level UPDATE only, checked below.
  presale_reward_rounds: ["blast_watcher:INSERT,SELECT", "blast_web:SELECT"],
  presale_reward_slots: ["blast_watcher:INSERT,SELECT,UPDATE"],
  // Reward delivery (0101): the relay's progress per published round, the rewards worker's alone.
  presale_reward_relays: ["blast_watcher:INSERT,SELECT,UPDATE"],
  // Why each unpaid leaf waits (0101): the relay rewrites it; the web's Rewards page reads it.
  presale_reward_relay_leaves: ["blast_watcher:DELETE,INSERT,SELECT,UPDATE", "blast_web:SELECT"],
};
/**
 * Mission Control's wallet and identity tables are `social_wallet_owners`'s
 * sources (0054): its watcher and replica readers read them too.
 */
const WALLET_SOURCE_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  mission_control_account_identities: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:DELETE,INSERT,SELECT,UPDATE"],
  mission_control_account_wallets: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:DELETE,INSERT,SELECT,UPDATE"],
};
/**
 * The social feed's relations (module `social`, migrations 0054 to 0059 and 0064) and
 * every table-level grant on each. The web runtime reads everything and
 * writes members' records, never deleting a why or an attribution and never
 * rewriting a report (0080); the watcher writes milestones, attributions,
 * intents' resolution and its cursors, and inserts whys; the replica reads
 * the feed's relations; the CLI runs as the owning migration login. No
 * runtime role deletes an attribution.
 */
const SOCIAL_FEED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  social_referral_reservations: ["blast_social:SELECT", "blast_watcher:SELECT", "blast_web:SELECT"],
  social_referral_entities: ["blast_social:SELECT", "blast_watcher:INSERT,SELECT", "blast_web:SELECT"],
  social_referral_events: ["blast_social:SELECT", "blast_watcher:INSERT,SELECT", "blast_web:SELECT"],
  social_referral_payments: [],
  social_blast_workspaces: ["blast_web:INSERT,SELECT,UPDATE"],
  social_blast_workspace_writers: ["blast_web:INSERT,SELECT,UPDATE"],
  social_accounts: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:INSERT,SELECT,UPDATE"],
  social_account_wallets: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:INSERT,SELECT,UPDATE"],
  social_follows: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:DELETE,INSERT,SELECT,UPDATE"],
  social_default_accounts: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:SELECT"],
  social_milestones: ["blast_replica:SELECT", "blast_watcher:INSERT,SELECT,UPDATE", "blast_web:SELECT"],
  social_whys: ["blast_replica:SELECT", "blast_watcher:INSERT,SELECT", "blast_web:INSERT,SELECT,UPDATE"],
  // 0080: a report is evidence, written once; the web runtime inserts one and never rewrites it.
  social_why_reports: ["blast_watcher:SELECT", "blast_web:INSERT,SELECT"],
  social_reactions: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:DELETE,INSERT,SELECT,UPDATE"],
  social_intents: ["blast_watcher:DELETE,INSERT,SELECT,UPDATE", "blast_web:INSERT,SELECT,UPDATE"],
  social_attributions: ["blast_replica:SELECT", "blast_watcher:INSERT,SELECT,UPDATE", "blast_web:SELECT"],
  social_config: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:SELECT"],
  social_blocked_terms: ["blast_watcher:SELECT", "blast_web:SELECT"],
  // 0165: the admin website's verified mark appends its log row as the web role; nobody rewrites one.
  social_operator_log: ["blast_watcher:SELECT", "blast_web:INSERT,SELECT"],
  social_wallet_balance_requests: ["blast_watcher:DELETE,SELECT"],
  social_worker_state: ["blast_watcher:INSERT,SELECT,UPDATE", "blast_web:SELECT"],
  social_wallet_owners: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:SELECT"],
  social_feed_entries: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:SELECT"],
  social_published_presales: ["blast_replica:SELECT", "blast_watcher:SELECT", "blast_web:SELECT"],
  // 0056: accounts' public identity, read by the item mapper on the primary or the replica.
  // 0057 replaces the view (adding `verified`) and keeps exactly these grants.
  social_account_identities: ["blast_replica:SELECT", "blast_web:SELECT"],
  // 0058: wallet sign-in sessions, the web runtime's alone (it sweeps expired rows).
  social_wallet_sessions: ["blast_web:DELETE,INSERT,SELECT,UPDATE"],
  // 0059: callsign to account (indexed), read by the public portfolio on the replica.
  social_account_callsigns: ["blast_replica:SELECT", "blast_web:SELECT"],
  social_callsign_aliases: ["blast_replica:SELECT", "blast_web:INSERT,SELECT"],
  // 0059: the notification switches; the web writes its own, the watcher (notifications) reads them.
  social_notification_preferences: ["blast_watcher:SELECT", "blast_web:INSERT,SELECT,UPDATE"],
  // 0064: notifications; the watcher writes and expires them, the web reads them and marks them read.
  social_notifications: ["blast_watcher:DELETE,INSERT,SELECT", "blast_web:SELECT,UPDATE"],
  // 0064: each account's "Mark all as read" watermark, the web runtime's alone.
  social_notification_reads: ["blast_web:INSERT,SELECT,UPDATE"],
  // 0068: presale drafts, the web runtime's alone (keyed by the resolved account).
  social_presale_drafts: ["blast_web:DELETE,INSERT,SELECT,UPDATE"],
  social_presale_publish_approvals: ["blast_web:INSERT,SELECT"],
  social_presale_raise_floor_rollout: ["blast_web:SELECT"],
  social_launch_drafts: ["blast_web:DELETE,INSERT,SELECT,UPDATE"],
  social_presale_pins: ["blast_replica:SELECT", "blast_web:DELETE,INSERT,SELECT"],
  // 0072: each account's starred presales, the web runtime's alone (private, never on the replica).
  social_watchlist: ["blast_web:DELETE,INSERT,SELECT"],
  // 0072: who search may find, read by the public search route on the replica.
  social_account_search: ["blast_replica:SELECT", "blast_web:SELECT"],
  // 0168: savers per presale (counts only), read by Home Trending on the primary and the replica.
  social_presale_savers: ["blast_replica:SELECT", "blast_web:SELECT"],
  // 0075: withdrawal records, the web runtime's alone; never deleted (audit).
  social_coin_transfers: ["blast_web:INSERT,SELECT,UPDATE"],
  // 0084 (R3-27): the transaction log (personal, never on the replica); the web logs and settles
  // rows, its trigger keeps every other column, and nobody deletes one. 0085 (T-026): the watcher
  // settles a logged commit from the chain, so it reads and updates and never inserts.
  social_transactions: ["blast_watcher:SELECT,UPDATE", "blast_web:INSERT,SELECT,UPDATE"],
  social_vesting_attempts: ["blast_web:INSERT,SELECT,UPDATE"],
  // 0088 (R3-23): a sale's trust flags. The web runtime reads them on the primary (watchlist) and
  // the replica on the public presale reads; 0165 lets the web role write the verified columns
  // only (column grants, below); the audited flag stays the operator CLI's (the owner).
  social_sale_trust: ["blast_replica:SELECT", "blast_web:SELECT"],
  // 0164: a curve coin's verified-team flag; 0165: the row is the mark, so the web role inserts and deletes it.
  social_coin_trust: ["blast_replica:SELECT", "blast_web:DELETE,INSERT,SELECT"],
  // 0089 (R3-31): trades, the web runtime's alone (personal, never on the replica); it records and
  // settles them, its trigger keeps every other column, and nobody deletes one.
  social_swap_receipts: ["blast_web:INSERT,SELECT"],
  social_competitions: ["blast_web:INSERT,SELECT"],
  social_swap_intents: ["blast_web:INSERT,SELECT,UPDATE"],
  // 0090 (R3-24): a sale's public details, written by its creator through the web (never deleted: clearing is an update)
  // and read by the public presale reads on the replica; their edits are evidence, inserted by the web and never changed.
  social_sale_metadata: ["blast_replica:SELECT", "blast_web:INSERT,SELECT,UPDATE"],
  social_sale_metadata_edits: ["blast_web:INSERT,SELECT"],
  // 0097 (OA-25 Q16): the daily portfolio value, written, retried and expired by the social worker; read by the
  // owner's portfolio on the primary and an opted-in public portfolio (OA-10) on the replica.
  social_portfolio_snapshots: ["blast_replica:SELECT", "blast_watcher:DELETE,INSERT,SELECT,UPDATE", "blast_web:SELECT"],
  // 0108: exact source observations are watcher-only; the revision is private to its SECURITY DEFINER guard.
  social_portfolio_balance_observations: ["blast_watcher:DELETE,INSERT,SELECT,UPDATE"],
  social_portfolio_source_revision: [],
  // 0100 (withdraw to another chain): CCTP withdrawals, the web runtime's alone (personal, never on the replica); it
  // records and settles them, its trigger keeps every other column and only moves them forward, and nobody deletes one.
  social_bridge_withdrawals: ["blast_web:INSERT,SELECT,UPDATE"],
  social_bridge_withdraw_claims: ["blast_web:INSERT,SELECT,UPDATE"],
  // 0135: creator-recipient commitments, the web runtime's alone; minted once, never changed or deleted.
  social_creator_commitments: ["blast_web:INSERT,SELECT"],
};
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";

/** Runs `sql` as `role` and returns "ok" or the SQLSTATE that refused it. */
async function attempt(admin: Pool, role: Role, sql: string): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(sql);
    return "ok";
  } catch (error) {
    return String((error as { code?: unknown }).code ?? error);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

test("the web migration shares blast-infra's roles and leaves CREATE on public to blast_indexer", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  try {
    await resetSharedDatabase(admin);
    // The web app migrates up to its first view over blast-infra's chain_read_v1
    // (0055 social_feed_entries), which waits for blast-infra's views.
    await assert.rejects(migrateDatabase(admin), /run blast-infra's migrations first/);
    await admin.query(CHAIN_FIXTURE);
    assert.equal((await migrateDatabase(admin))[0], "0055_social_feed_entries");
    assert.deepEqual(await migrateDatabase(admin), []);

    const roles = await admin.query<{ rolname: string; rolcanlogin: boolean }>(
      "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname",
      [ROLES],
    );
    assert.deepEqual(roles.rows.map((row) => row.rolname), [...ROLES].sort());
    assert.ok(roles.rows.every((row) => !row.rolcanlogin), "shared roles are NOLOGIN");

    const create = await admin.query<{ role: string; create: boolean }>(
      `SELECT role, has_schema_privilege(role, 'public', 'CREATE') AS create
       FROM unnest($1::text[]) AS role ORDER BY role`,
      [ROLES],
    );
    assert.deepEqual(
      Object.fromEntries(create.rows.map((row) => [row.role, row.create])),
      {
        blast_indexer: true,
        blast_migration: true,
        blast_replica: false,
        blast_social: false,
        blast_watcher: false,
        blast_web: false,
      },
    );

    // Every web table is the web runtime's to read and write, and no one else's.
    const grants = await admin.query<{ table_name: string; grantee: string; privileges: string }>(
      `SELECT table_name::text, grantee::text,
              string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
       FROM information_schema.role_table_grants
       WHERE table_schema = 'public' AND table_name LIKE 'mission\\_control\\_%'
         AND grantee = ANY($1)
       GROUP BY table_name, grantee`,
      [ROLES],
    );
    const tables = await admin.query<{ table_name: string }>(
      `SELECT table_name::text FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'mission\\_control\\_%'
         AND table_name <> 'mission_control_schema_migrations'`,
    );
    const names = tables.rows.map((row) => row.table_name);
    for (const table of ["mission_control_profiles", "mission_control_seasons", "mission_control_card_images"]) {
      assert.ok(names.includes(table), table);
    }
    // The operational worker's tables are the watcher's alone, never the web runtime's.
    for (const table of Object.keys(WATCHER_TABLE_PRIVILEGES)) assert.ok(names.includes(table), table);
    for (const table of Object.keys(SOCIAL_TABLE_GRANTS)) assert.ok(names.includes(table), table);
    for (const table of Object.keys(LAUNCHPAD_TABLE_GRANTS)) assert.ok(names.includes(table), table);
    assert.deepEqual(
      new Set(grants.rows.map((row) => `${row.table_name}:${row.grantee}:${row.privileges}`)),
      new Set(tables.rows.flatMap((row) => {
        const watcher = WATCHER_TABLE_PRIVILEGES[row.table_name];
        const social = SOCIAL_TABLE_GRANTS[row.table_name] ?? LAUNCHPAD_TABLE_GRANTS[row.table_name] ??
          WALLET_SOURCE_TABLE_GRANTS[row.table_name];
        if (watcher) return [`${row.table_name}:blast_watcher:${watcher}`];
        if (social) return social.map((grant) => `${row.table_name}:${grant}`);
        return [`${row.table_name}:blast_web:DELETE,INSERT,SELECT,UPDATE`];
      })),
    );
    const presale = await admin.query<{ table_name: string; grants: string[] }>(
      `SELECT t.table_name::text,
              coalesce(array_agg(g.grantee || ':' || g.privileges ORDER BY g.grantee)
                FILTER (WHERE g.grantee IS NOT NULL), '{}') AS grants
       FROM information_schema.tables t
       LEFT JOIN (
         SELECT table_name, grantee::text AS grantee,
                string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND grantee = ANY($1)
         GROUP BY table_name, grantee
       ) g USING (table_name)
       WHERE t.table_schema = 'public' AND t.table_name LIKE 'presale\\_%'
       GROUP BY t.table_name`,
      [ROLES],
    );
    assert.deepEqual(
      Object.fromEntries(presale.rows.map((row) => [row.table_name, row.grants])),
      PRESALE_TABLE_GRANTS,
    );
    // Social tables and views have exactly the table and column grants in their contract.
    const socialFeed = await admin.query<{ table_name: string; grants: string[] }>(
      `SELECT t.table_name::text,
              coalesce(array_agg(g.grantee || ':' || g.privileges ORDER BY g.grantee)
                FILTER (WHERE g.grantee IS NOT NULL), '{}') AS grants
       FROM information_schema.tables t
       LEFT JOIN (
         SELECT table_name, grantee::text AS grantee,
                string_agg(privilege_type, ',' ORDER BY privilege_type) AS privileges
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND grantee = ANY($1)
         GROUP BY table_name, grantee
       ) g USING (table_name)
       WHERE t.table_schema = 'public' AND t.table_name LIKE 'social\\_%'
       GROUP BY t.table_name`,
      [ROLES],
    );
    assert.deepEqual(
      Object.fromEntries(socialFeed.rows.map((row) => [row.table_name, row.grants])),
      SOCIAL_FEED_GRANTS,
    );
    const socialColumns = await admin.query(
      `SELECT c.grantee || ':' || c.table_name || ':' || c.column_name || ':' || c.privilege_type AS grant
       FROM information_schema.column_privileges c
       WHERE c.table_schema = 'public' AND c.table_name LIKE 'social\\_%' AND c.grantee = ANY($1)
         AND NOT EXISTS (
           SELECT 1 FROM information_schema.role_table_grants t
           WHERE t.table_schema = 'public' AND t.table_name = c.table_name
             AND t.grantee = c.grantee AND t.privilege_type = c.privilege_type
         )`,
      [ROLES],
    );
    assert.deepEqual(
      socialColumns.rows.map((row) => row.grant).sort(),
      [
        "blast_watcher:social_wallet_balance_requests:owner:UPDATE",
        ...["account_id", "month", "amount_atoms", "digest"].map((column) => `blast_web:social_referral_payments:${column}:SELECT`),
        // 0165: the admin website's verified mark, never the audited flag.
        ...["presale_id", "verified_team", "verified_by", "verified_at_ms", "note", "updated_at_ms"].map((column) => `blast_web:social_sale_trust:${column}:INSERT`),
        ...["verified_team", "verified_by", "verified_at_ms", "note", "updated_at_ms"].map((column) => `blast_web:social_sale_trust:${column}:UPDATE`),
      ].sort(),
      "social column-level privileges are limited to the named fields",
    );
    // T-026 Q-013: a holder-reward round's only updatable columns are its progress, never its stored header.
    const roundProgress = await admin.query<{ grant: string }>(
      `SELECT grantee || ':' || column_name AS grant FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'presale_reward_rounds'
         AND privilege_type = 'UPDATE' AND grantee = ANY($1)
       ORDER BY 1`,
      [ROLES],
    );
    assert.deepEqual(
      roundProgress.rows.map((row) => row.grant),
      ["announced_at", "blob_url", "error_class", "publish_digest", "published_at", "reset_outcome", "round_id", "state", "updated_at"].map((column) => `blast_watcher:${column}`),
    );
    // A thesis's only updatable columns are its visibility, and only for the web runtime.
    const updatable = await admin.query<{ grant: string }>(
      `SELECT grantee || ':' || column_name AS grant FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'mission_control_launchpad_theses'
         AND privilege_type = 'UPDATE' AND grantee = ANY($1)
       ORDER BY 1`,
      [ROLES],
    );
    assert.deepEqual(updatable.rows.map((row) => row.grant), [
      "blast_web:visibility",
      "blast_web:visibility_changed_at",
    ]);
    // An API key's only updatable columns are its revocation time and revoking operator, and only for the web runtime.
    const revocable = await admin.query<{ grant: string }>(
      `SELECT grantee || ':' || column_name AS grant FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'presale_api_keys'
         AND privilege_type = 'UPDATE' AND grantee = ANY($1)
       ORDER BY 1`,
      [ROLES],
    );
    assert.deepEqual(revocable.rows.map((row) => row.grant), ["blast_web:revoked_at", "blast_web:revoked_by"]);
    // A bridge transfer's progress is the relayer worker's only update: never what the user registered.
    // 0051 (T-021 B-009/B-010): the worker also records Circle's "not found"; the web runtime may only
    // re-arm a parked transfer on a repeat registration (next poll, observation window, evidence).
    const progress = await admin.query<{ grant: string }>(
      `SELECT grantee || ':' || column_name AS grant FROM information_schema.column_privileges
       WHERE table_schema = 'public' AND table_name = 'presale_bridge_transfers'
         AND privilege_type = 'UPDATE' AND grantee = ANY($1)
       ORDER BY 1`,
      [ROLES],
    );
    assert.deepEqual(progress.rows.map((row) => row.grant), [
      ...[
        "attestation", "attested_at", "circle_not_found_at", "error", "failed_at", "message", "minted_at", "next_poll_at", "nonce",
        "poll_count", "status", "sui_digest",
      ].map((column) => `blast_watcher:${column}`),
      ...["circle_not_found_at", "next_poll_at", "observed_from"].map((column) => `blast_web:${column}`),
    ]);
  } finally {
    await admin.end();
  }
});

test("the web app retires its own chain_v1 views: blast-infra's chain_read_v1 is the only chain contract", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  try {
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    // A database an earlier web release migrated: it has not applied 0034
    // and it created chain_v1 over the chain tables.
    const all = await migrateDatabase(admin);
    await admin.query("DELETE FROM mission_control_schema_migrations WHERE name = '0034_chain_read_views'");
    await admin.query("CREATE SCHEMA chain_v1; CREATE VIEW chain_v1.coin_identity AS SELECT coin_type FROM coins");
    assert.ok(all.includes("0034_chain_read_views"), all.join());

    assert.deepEqual(await migrateDatabase(admin), ["0034_chain_read_views"]);
    const schemas = await admin.query<{ nspname: string }>(
      "SELECT nspname::text FROM pg_namespace WHERE nspname LIKE 'chain%' ORDER BY 1",
    );
    assert.deepEqual(schemas.rows.map((row) => row.nspname), ["chain_read_v1"]);
    assert.deepEqual(await migrateDatabase(admin), [], "rerunnable");
  } finally {
    await admin.end();
  }
});

test("each role performs only its named table operations and cross-owner writes are refused", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  try {
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    await migrateDatabase(admin);

    const operations: Record<string, readonly Role[]> = {
      "SELECT count(*) FROM mission_control_profiles": ["blast_web"],
      "UPDATE mission_control_seasons SET season_id = season_id WHERE FALSE": ["blast_web"],
      "DELETE FROM mission_control_campaign_events WHERE FALSE": ["blast_web"],
      "INSERT INTO mission_control_seasons (season_id) VALUES ('role-probe')": ["blast_web"],
      "TRUNCATE mission_control_oauth_states": [],
      // The worker writes only its own tables, and the web runtime never writes them.
      [`INSERT INTO mission_control_worker_leases (job, lease_key, holder, acquired_at, expires_at)
        VALUES ('coin-registration', 'probe', gen_random_uuid(), now(), now() + interval '1 second')`]: ["blast_watcher"],
      "DELETE FROM mission_control_worker_leases WHERE FALSE": ["blast_watcher"],
      "UPDATE mission_control_worker_jobs SET updated_at = updated_at WHERE FALSE": ["blast_watcher"],
      "SELECT count(*) FROM mission_control_coin_registrations": ["blast_watcher"],
      "UPDATE mission_control_coin_registrations SET updated_at = updated_at WHERE FALSE": ["blast_watcher"],
      "DELETE FROM mission_control_coin_registrations WHERE FALSE": [],
      "TRUNCATE mission_control_coin_registrations": [],
      "SELECT count(*) FROM mission_control_launch_migrations": ["blast_watcher"],
      "UPDATE mission_control_launch_migrations SET updated_at = updated_at WHERE FALSE": ["blast_watcher"],
      "DELETE FROM mission_control_launch_migrations WHERE FALSE": [],
      "TRUNCATE mission_control_launch_migrations": [],
      "UPDATE mission_control_worker_submissions SET resolved_at = resolved_at WHERE FALSE": ["blast_watcher"],
      "DELETE FROM mission_control_worker_submissions WHERE FALSE": [],
      "ALTER TABLE mission_control_profiles ADD COLUMN role_probe INT": [],
      // Social records are immutable: the web runtime inserts them and changes only
      // their visibility; nobody deletes a thesis or a moderation action.
      "SELECT count(*) FROM mission_control_launchpad_theses": ["blast_web", "blast_replica"],
      "UPDATE mission_control_launchpad_theses SET visibility = visibility, visibility_changed_at = now() WHERE FALSE": ["blast_web"],
      "UPDATE mission_control_launchpad_theses SET body = body WHERE FALSE": [],
      "UPDATE mission_control_launchpad_theses SET launch_id = launch_id WHERE FALSE": [],
      "DELETE FROM mission_control_launchpad_theses WHERE FALSE": [],
      "SELECT count(*) FROM mission_control_launchpad_social_authors": ["blast_web"],
      "UPDATE mission_control_launchpad_social_authors SET author_wallet = author_wallet WHERE FALSE": [],
      "DELETE FROM mission_control_launchpad_social_authors WHERE FALSE": [],
      "SELECT count(*) FROM mission_control_launchpad_thesis_moderation": ["blast_web"],
      "UPDATE mission_control_launchpad_thesis_moderation SET reason = reason WHERE FALSE": [],
      "DELETE FROM mission_control_launchpad_thesis_moderation WHERE FALSE": [],
      "SELECT count(*) FROM mission_control_launchpad_search_documents": ["blast_web", "blast_replica"],
      "DELETE FROM mission_control_launchpad_search_documents WHERE FALSE": ["blast_web"],
      "UPDATE mission_control_launchpad_search_documents SET search_text = search_text WHERE FALSE": [],
      // Outcomes link visitors to wallets and their commitments name visitors: the web runtime's alone.
      "SELECT count(*) FROM mission_control_launchpad_outcomes": ["blast_web"],
      "UPDATE mission_control_launchpad_outcomes SET visitor_link = visitor_link WHERE FALSE": ["blast_web"],
      "SELECT count(*) FROM mission_control_launchpad_outcome_commitments": ["blast_web"],
      "DELETE FROM mission_control_launchpad_outcome_commitments WHERE FALSE": ["blast_web"],
      "UPDATE mission_control_launchpad_outcome_commitments SET committed_at = committed_at WHERE FALSE": [],
      "TRUNCATE mission_control_launchpad_outcome_commitments": [],
      "SELECT count(*) FROM mission_control_schema_migrations": [],
      // The presale embedded wallet cache: the web runtime reads and inserts, nobody rewrites a row;
      // the watcher and the replica read it as a source of social_wallet_owners (0054).
      "SELECT count(*) FROM presale_embedded_wallets": ["blast_web", "blast_watcher", "blast_replica"],
      [`INSERT INTO presale_embedded_wallets (privy_did, address)
        VALUES ('did:privy:role-probe', '0x${"0".repeat(63)}1')`]: ["blast_web"],
      "UPDATE presale_embedded_wallets SET address = address WHERE FALSE": [],
      "DELETE FROM presale_embedded_wallets WHERE FALSE": [],
      "TRUNCATE presale_embedded_wallets": [],
      // Presale outcomes link visitors and accounts to wallets: the web runtime's alone; only links change,
      // and the maintenance cleanup (run as the web runtime) deletes them after the retention.
      "SELECT count(*) FROM presale_outcomes": ["blast_web"],
      "UPDATE presale_outcomes SET privy_did = privy_did, visitor_id = visitor_id, visitor_link = visitor_link WHERE FALSE": ["blast_web"],
      "UPDATE presale_outcomes SET sender_wallet = sender_wallet WHERE FALSE": [],
      "DELETE FROM presale_outcomes WHERE FALSE": ["blast_web"],
      "SELECT count(*) FROM presale_outcome_commitments": ["blast_web"],
      "DELETE FROM presale_outcome_commitments WHERE FALSE": ["blast_web"],
      "UPDATE presale_outcome_commitments SET committed_at = committed_at WHERE FALSE": [],
      "TRUNCATE presale_outcome_commitments": [],
      // Account settings: the web runtime reads, inserts and replaces an account's row; nobody deletes one.
      "SELECT count(*) FROM presale_account_settings": ["blast_web"],
      [`INSERT INTO presale_account_settings (privy_did, explorer, theme)
        VALUES ('did:privy:role-probe', 'suiscan', 'dark')
        ON CONFLICT (privy_did) DO UPDATE SET explorer = EXCLUDED.explorer, theme = EXCLUDED.theme, updated_at = now()`]: ["blast_web"],
      "UPDATE presale_account_settings SET theme = theme WHERE FALSE": ["blast_web"],
      "DELETE FROM presale_account_settings WHERE FALSE": [],
      "TRUNCATE presale_account_settings": [],
      // Allowlists and API keys (0041): inserted and read by the web runtime; a key may only be revoked.
      "SELECT count(*) FROM presale_api_keys": ["blast_web"],
      [`INSERT INTO presale_api_keys (id, label, key_hash, issued_by)
        VALUES (gen_random_uuid(), 'role-probe', sha256('role-probe'::bytea), 'operator:role-probe')`]: ["blast_web"],
      "UPDATE presale_api_keys SET revoked_at = now(), revoked_by = 'operator:role-probe' WHERE FALSE": ["blast_web"],
      "UPDATE presale_api_keys SET issued_by = issued_by WHERE FALSE": [],
      "UPDATE presale_api_keys SET key_hash = key_hash WHERE FALSE": [],
      "UPDATE presale_api_keys SET label = label WHERE FALSE": [],
      "DELETE FROM presale_api_keys WHERE FALSE": [],
      "SELECT count(*) FROM presale_allowlists": ["blast_web"],
      [`INSERT INTO presale_allowlists (id, owner_kind, owner_id, quote, root, leaf_count, entry_count, total_cap, warnings)
        VALUES (gen_random_uuid(), 'account', 'did:privy:role-probe', '0x${"0".repeat(63)}2::sui::SUI', '${"a".repeat(64)}', 1, 1, 1, '[]')`]: ["blast_web"],
      "UPDATE presale_allowlists SET root = root WHERE FALSE": [],
      "DELETE FROM presale_allowlists WHERE FALSE": [],
      "TRUNCATE presale_api_keys": [],
      "TRUNCATE presale_allowlists": [],
      "SELECT count(*) FROM presale_allowlist_entries": ["blast_web"],
      // A real entry row: its manifest is inserted by the same statement, so the foreign key holds.
      [`WITH manifest AS (
          INSERT INTO presale_allowlists (id, owner_kind, owner_id, quote, root, leaf_count, entry_count, total_cap, warnings)
          VALUES (gen_random_uuid(), 'account', 'did:privy:role-probe', '0x${"0".repeat(63)}2::sui::SUI', '${"a".repeat(64)}', 1, 1, 1, '[]')
          RETURNING id)
        INSERT INTO presale_allowlist_entries (allowlist_id, index, wallet, wallet_cap, proof)
        SELECT id, 0, '0x${"0".repeat(63)}1', 1, '{}' FROM manifest`]: ["blast_web"],
      "UPDATE presale_allowlist_entries SET proof = proof WHERE FALSE": [],
      "DELETE FROM presale_allowlist_entries WHERE FALSE": [],
      "TRUNCATE presale_allowlist_entries": [],
      // The presale release gate: the workers read it; only its owner records a check.
      "SELECT count(*) FROM presale_release_gate_checks": ["blast_watcher"],
      [`INSERT INTO presale_release_gate_checks (network, identity_digest, check_name, passed, evidence)
        VALUES ('mainnet', '${"0".repeat(64)}', 'worker-host', TRUE, 'role probe')`]: [],
      "UPDATE presale_release_gate_checks SET passed = TRUE WHERE FALSE": [],
      "DELETE FROM presale_release_gate_checks WHERE FALSE": [],
      // The keyless rewards planner and watcher can raise, throttle and clear alerts.
      "SELECT count(*) FROM blast_worker_alerts": ["blast_indexer", "blast_migration", "blast_watcher"],
      "INSERT INTO blast_worker_alerts(alert_key,condition_since,updated_at) VALUES ('planner_role_probe',now(),now())": ["blast_indexer", "blast_migration", "blast_watcher"],
      "UPDATE blast_worker_alerts SET updated_at=updated_at WHERE FALSE": ["blast_indexer", "blast_migration", "blast_watcher"],
      "DELETE FROM blast_worker_alerts WHERE FALSE": ["blast_indexer", "blast_migration", "blast_watcher"],
      "TRUNCATE blast_worker_alerts": [],
      // Bridge transfers: the web runtime registers and reads; the relayer worker reads and advances progress.
      "SELECT count(*) FROM presale_bridge_transfers": ["blast_web", "blast_watcher"],
      [`INSERT INTO presale_bridge_transfers (source, source_domain, tx_hash, sui_address, amount, presale_id)
        VALUES ('base', 6, '0x${"ab".repeat(32)}', '0x${"0".repeat(63)}1', 1, '0x${"0".repeat(63)}2')`]: ["blast_web"],
      "UPDATE presale_bridge_transfers SET status = status, poll_count = poll_count, next_poll_at = next_poll_at WHERE FALSE": ["blast_watcher"],
      "UPDATE presale_bridge_transfers SET circle_not_found_at = circle_not_found_at WHERE FALSE": ["blast_web", "blast_watcher"],
      "UPDATE presale_bridge_transfers SET next_poll_at = next_poll_at, observed_from = observed_from WHERE FALSE": ["blast_web"],
      "UPDATE presale_bridge_transfers SET status = status WHERE FALSE": ["blast_watcher"],
      "UPDATE presale_bridge_transfers SET amount = amount WHERE FALSE": [],
      "UPDATE presale_bridge_transfers SET sui_address = sui_address, tx_hash = tx_hash WHERE FALSE": [],
      "DELETE FROM presale_bridge_transfers WHERE FALSE": [],
      "TRUNCATE presale_bridge_transfers": [],
      // Activation records are inserted and read, never changed: the history stays.
      "SELECT count(*) FROM presale_bridge_activations": ["blast_web", "blast_watcher"],
      [`INSERT INTO presale_bridge_activations (recorded_by, kind, checklist, complete, problems)
        VALUES ('operator:role-probe', 'deactivation', '{"reason":"probe"}', false, '{deactivated}')`]: ["blast_web"],
      "UPDATE presale_bridge_activations SET complete = complete WHERE FALSE": [],
      "DELETE FROM presale_bridge_activations WHERE FALSE": [],
      "TRUNCATE presale_bridge_activations": [],
      // Sponsor reservations: the web runtime inserts and updates, nobody deletes; refusal counts feed the worker's alert.
      "SELECT count(*) FROM presale_sponsor_reservations": ["blast_web"],
      "UPDATE presale_sponsor_reservations SET state = state WHERE FALSE": ["blast_web"],
      "DELETE FROM presale_sponsor_reservations WHERE FALSE": [],
      "TRUNCATE presale_sponsor_reservations": [],
      "SELECT count(*) FROM presale_sponsor_refusal_counts": ["blast_web", "blast_watcher"],
      [`INSERT INTO presale_sponsor_refusal_counts (hour, reason, count)
        VALUES ('2026-10-02T21:00:00Z', 'role probe', 1)
        ON CONFLICT (hour, reason) DO UPDATE SET count = presale_sponsor_refusal_counts.count + 1`]: ["blast_web"],
      "DELETE FROM presale_sponsor_refusal_counts WHERE FALSE": [],
      // Receipt image catalog: the web runtime reads and inserts (first row wins); a row never changes.
      "SELECT count(*) FROM presale_receipt_images": ["blast_web"],
      [`INSERT INTO presale_receipt_images (presale_id, wallet, format, record_digest, pathname, url, content_type, byte_size)
        VALUES ('0x${"a".repeat(64)}', '0x${"b".repeat(64)}', 'card', '${"c".repeat(64)}', 'p', 'u', 'image/png', 1)
        ON CONFLICT (presale_id, wallet, format, record_digest) DO NOTHING`]: ["blast_web"],
      "UPDATE presale_receipt_images SET url = url WHERE FALSE": [],
      "DELETE FROM presale_receipt_images WHERE FALSE": [],
      "TRUNCATE presale_receipt_images": [],
      // Allowlist bindings (0047): inserted and read by the web runtime; nobody replaces or deletes a binding.
      "SELECT count(*) FROM presale_allowlist_bindings": ["blast_web"],
      [`WITH manifest AS (
          INSERT INTO presale_allowlists (id, owner_kind, owner_id, quote, root, leaf_count, entry_count, total_cap, warnings)
          VALUES (gen_random_uuid(), 'account', 'did:privy:role-probe', '0x${"0".repeat(63)}2::sui::SUI', '${"a".repeat(64)}', 1, 1, 1, '[]')
          RETURNING id)
        INSERT INTO presale_allowlist_bindings (presale_id, allowlist_id, bound_by)
        SELECT '0x${"0".repeat(63)}3', id, 'proof_route' FROM manifest
        ON CONFLICT (presale_id) DO NOTHING`]: ["blast_web"],
      "UPDATE presale_allowlist_bindings SET allowlist_id = allowlist_id WHERE FALSE": [],
      "DELETE FROM presale_allowlist_bindings WHERE FALSE": [],
      "TRUNCATE presale_allowlist_bindings": [],
      // Holder ledgers (0049): the rewards worker (and its operator command, as the watcher) only; the web runtime never sees them.
      "SELECT count(*) FROM presale_reward_ledgers": ["blast_watcher"],
      [`INSERT INTO presale_reward_ledgers (coin_type, presale_id)
        VALUES ('0x${"0".repeat(63)}4::probe::PROBE', '0x${"0".repeat(63)}5') ON CONFLICT DO NOTHING`]: ["blast_watcher"],
      "UPDATE presale_reward_ledgers SET revision = revision WHERE FALSE": ["blast_watcher"],
      "DELETE FROM presale_reward_ledgers WHERE FALSE": ["blast_watcher"],
      "TRUNCATE presale_reward_ledgers": [],
      "SELECT count(*) FROM presale_reward_ledger_accounts": ["blast_watcher"],
      "DELETE FROM presale_reward_ledger_accounts WHERE FALSE": ["blast_watcher"],
      "TRUNCATE presale_reward_ledger_accounts": [],
      "SELECT count(*) FROM presale_reward_fee_destinations JOIN presale_reward_fee_policies USING (fee_policy_id)": ["blast_watcher"],
      "TRUNCATE presale_reward_fee_policies": [],
      "TRUNCATE presale_reward_fee_destinations": [],
      // Holder-reward rounds (0052): the workers write slots and rounds; an allocation's mark never changes; the web reads rounds and allocations.
      "SELECT count(*) FROM presale_reward_rounds JOIN presale_reward_allocations ON presale_reward_allocations.round = presale_reward_rounds.id": ["blast_web", "blast_watcher"],
      "UPDATE presale_reward_rounds SET state = state WHERE FALSE": ["blast_watcher"],
      "UPDATE presale_reward_rounds SET root = root, manifest_digest = manifest_digest WHERE FALSE": [],
      "UPDATE presale_reward_rounds SET meme_amount = meme_amount WHERE FALSE": [],
      "DELETE FROM presale_reward_rounds WHERE FALSE": [],
      "UPDATE presale_reward_allocations SET delivery = delivery WHERE FALSE": [],
      "DELETE FROM presale_reward_allocations WHERE FALSE": [],
      "TRUNCATE presale_reward_allocations": [],
      "SELECT count(*) FROM presale_reward_slots": ["blast_watcher"],
      "SELECT count(*) FROM presale_reward_chain_rounds": ["blast_watcher"],
      "DELETE FROM presale_reward_chain_rounds WHERE FALSE": [],
      "UPDATE presale_reward_slots SET state = state WHERE FALSE": ["blast_watcher"],
      "DELETE FROM presale_reward_slots WHERE FALSE": [],
      [`INSERT INTO presale_reward_event_cursors (network, cursor) VALUES ('localnet', '1')
        ON CONFLICT (network) DO UPDATE SET cursor = EXCLUDED.cursor`]: ["blast_watcher"],
      // Lifecycle records (0048) with claim delivery's columns (0050): the watcher reads and updates them, nobody deletes.
      "SELECT count(*) FROM presale_lifecycle_records": ["blast_watcher"],
      [`UPDATE presale_lifecycle_records SET claim_digest = claim_digest, claim_batches = claim_batches, claim_failures = claim_failures,
        claim_batch_size = claim_batch_size, claim_blocked_reason = claim_blocked_reason, unpaid_wallets = unpaid_wallets,
        delivered_at = delivered_at, state = state WHERE FALSE`]: ["blast_watcher"],
      "DELETE FROM presale_lifecycle_records WHERE FALSE": [],
      "TRUNCATE presale_lifecycle_records": [],
      // Social feed (0054, 0055). No runtime role deletes a why or an attribution (AC-087, AC-106).
      "DELETE FROM social_whys WHERE FALSE": [],
      "UPDATE social_whys SET state = state WHERE FALSE": ["blast_web"],
      "DELETE FROM social_attributions WHERE FALSE": [],
      "TRUNCATE social_attributions": [],
      "UPDATE social_attributions SET voided_at = voided_at WHERE FALSE": ["blast_watcher"],
      "DELETE FROM social_intents WHERE FALSE": ["blast_watcher"],
      "UPDATE social_intents SET status = status WHERE FALSE": ["blast_web", "blast_watcher"],
      "DELETE FROM social_follows WHERE FALSE": ["blast_web"],
      "DELETE FROM social_reactions WHERE FALSE": ["blast_web"],
      "DELETE FROM social_accounts WHERE FALSE": [],
      "UPDATE social_milestones SET digest = digest WHERE FALSE": ["blast_watcher"],
      "UPDATE social_worker_state SET value = value WHERE FALSE": ["blast_watcher"],
      // 0064: the web marks read, the watcher inserts and deletes.
      "UPDATE social_notifications SET read_at = read_at WHERE FALSE": ["blast_web"],
      "DELETE FROM social_notifications WHERE FALSE": ["blast_watcher"],
      "SELECT count(*) FROM social_notifications": ["blast_web", "blast_watcher"],
      "UPDATE social_notification_reads SET read_through = read_through WHERE FALSE": ["blast_web"],
      "DELETE FROM social_notification_reads WHERE FALSE": [],
      // 0068: drafts are the web runtime's; no worker or the replica reads them.
      "SELECT count(*) FROM social_presale_drafts": ["blast_web"],
      "SELECT count(*) FROM social_launch_drafts": ["blast_web"],
      "DELETE FROM social_launch_drafts WHERE FALSE": ["blast_web"],
      "TRUNCATE social_launch_drafts": [],
      "SELECT presale_id, published_at_ms FROM social_published_presales": ["blast_web", "blast_watcher", "blast_replica"],
      "DELETE FROM social_presale_drafts WHERE FALSE": ["blast_web"],
      // 0072: the watchlist is the web runtime's alone; the replica reads public search rows, never a profile.
      "SELECT count(*) FROM social_watchlist": ["blast_web"],
      "DELETE FROM social_watchlist WHERE FALSE": ["blast_web"],
      "UPDATE social_watchlist SET created_at = created_at WHERE FALSE": [],
      "SELECT callsign, display_name, avatar_url, verified FROM social_account_search WHERE haystack LIKE '%a%'": ["blast_web", "blast_replica"],
      // 0168: the replica reads the savers counts, never the watchlist rows behind them.
      "SELECT presale_id, savers, gained_1h, gained_24h FROM social_presale_savers": ["blast_web", "blast_replica"],
      // 0075: withdrawal records: the web records and settles them; nobody deletes one.
      "SELECT count(*) FROM social_coin_transfers": ["blast_web"],
      "UPDATE social_coin_transfers SET status = status WHERE FALSE": ["blast_web"],
      "DELETE FROM social_coin_transfers WHERE FALSE": [],
      // 0084: the transaction log: the web logs and settles rows; nobody deletes or truncates one, and the replica never reads it.
      // 0085: the watcher reads and settles rows (a commit, from the chain) and inserts none.
      "SELECT count(*) FROM social_transactions": ["blast_web", "blast_watcher"],
      "UPDATE social_transactions SET state = state, digest = digest, settled_at_ms = settled_at_ms, failure_code = failure_code WHERE FALSE": ["blast_web", "blast_watcher"],
      "INSERT INTO social_transactions (tx_id, account_id, kind, idempotency_key) SELECT gen_random_uuid(), account_id, 'commit', 'k' FROM social_accounts WHERE FALSE": ["blast_web"],
      "DELETE FROM social_transactions WHERE FALSE": [],
      "TRUNCATE social_transactions": [],
      // 0089: trades: the web records and settles them; nobody deletes or truncates one, and no worker or the replica reads them.
      "SELECT count(*) FROM social_swap_intents": ["blast_web"],
      "UPDATE social_swap_intents SET state = state, failure_code = failure_code, amount_out_filled = amount_out_filled, settled_at_ms = settled_at_ms WHERE FALSE": ["blast_web"],
      "DELETE FROM social_swap_intents WHERE FALSE": [],
      "TRUNCATE social_swap_intents": [],
      // 0100: withdrawals to another chain: the web records and settles them; nobody deletes or truncates one, and no worker or the replica reads them.
      "SELECT count(*) FROM social_blast_workspaces": ["blast_web"],
      "INSERT INTO social_blast_workspaces (account_id, schema_version, workspace, revision, saved_at_ms) SELECT account_id, 1, '{\"schema_version\":1}'::jsonb, 1, 1 FROM social_accounts WHERE FALSE": ["blast_web"],
      "UPDATE social_blast_workspaces SET revision = revision WHERE FALSE": ["blast_web"],
      "DELETE FROM social_blast_workspaces WHERE FALSE": [],
      "TRUNCATE social_blast_workspaces": [],
      "SELECT count(*) FROM social_blast_workspace_writers": ["blast_web"],
      "INSERT INTO social_blast_workspace_writers (account_id, writer_id, sequence, payload_fingerprint, accepted_revision, saved_at_ms) SELECT account_id, 'fixture', 1, repeat('a', 64), 1, 1 FROM social_accounts WHERE FALSE": ["blast_web"],
      "UPDATE social_blast_workspace_writers SET sequence = sequence WHERE FALSE": ["blast_web"],
      "DELETE FROM social_blast_workspace_writers WHERE FALSE": [],
      "TRUNCATE social_blast_workspace_writers": [],
      "SELECT count(*) FROM social_bridge_withdrawals": ["blast_web"],
      "UPDATE social_bridge_withdrawals SET state = state, failure_code = failure_code, destination_tx_hash = destination_tx_hash WHERE FALSE": ["blast_web"],
      "DELETE FROM social_bridge_withdrawals WHERE FALSE": [],
      "TRUNCATE social_bridge_withdrawals": [],
      // 0090 (R3-24): sale details; nobody deletes a row, and no runtime role changes or removes an edit (its trigger also refuses the owner).
      "SELECT count(*) FROM social_sale_metadata": ["blast_web", "blast_replica"],
      "UPDATE social_sale_metadata SET tagline = tagline WHERE FALSE": ["blast_web"],
      "DELETE FROM social_sale_metadata WHERE FALSE": [],
      "SELECT count(*) FROM social_sale_metadata_edits": ["blast_web"],
      "UPDATE social_sale_metadata_edits SET at_ms = at_ms WHERE FALSE": [],
      "DELETE FROM social_sale_metadata_edits WHERE FALSE": [],
      "UPDATE social_config SET value = value WHERE FALSE": [],
      "DELETE FROM social_operator_log WHERE FALSE": [],
      "UPDATE social_operator_log SET reason = reason WHERE FALSE": [],
      // 0088 (R3-23): the trust flags are read by the web and the replica; 0165: the web role
      // writes the verified mark (the admin website) and never the audited flag or a delete.
      "SELECT verified_team, audited FROM social_sale_trust": ["blast_web", "blast_replica"],
      [`INSERT INTO social_sale_trust (presale_id, verified_team, verified_by, verified_at_ms, updated_at_ms)
        VALUES ('0x${"0".repeat(63)}8', TRUE, 'role-probe', 1, 1)`]: ["blast_web"],
      "UPDATE social_sale_trust SET verified_team = verified_team, note = note WHERE FALSE": ["blast_web"],
      [`INSERT INTO social_sale_trust (presale_id, audited, audited_by, audited_at_ms, updated_at_ms)
        VALUES ('0x${"0".repeat(63)}8', TRUE, 'role-probe', 1, 1)`]: [],
      "UPDATE social_sale_trust SET audited = audited WHERE FALSE": [],
      "DELETE FROM social_sale_trust WHERE FALSE": [],
      "SELECT coin_type FROM social_coin_trust": ["blast_web", "blast_replica"],
      "DELETE FROM social_coin_trust WHERE FALSE": ["blast_web"],
      "UPDATE social_coin_trust SET note = note WHERE FALSE": [],
      [`SELECT f.entry_id, w.account_id FROM social_feed_entries f
        LEFT JOIN social_wallet_owners w ON w.address = f.actor`]: ["blast_web", "blast_watcher", "blast_replica"],
      // 0056: the replica reads accounts' public identity, though not mission_control_profiles itself.
      "SELECT callsign, display_name, avatar_url, x_handle FROM social_account_identities": ["blast_web", "blast_replica"],
      // 0057: `verified` (OA-8, X linked) is readable where the identity is; the X subject behind it is not.
      "SELECT callsign, verified FROM social_account_identities": ["blast_web", "blast_replica"],
      "SELECT count(*) FROM social_why_reports": ["blast_web", "blast_watcher"],
      // 0080 (T-022): a report is written once; no runtime role rewrites or deletes one.
      "UPDATE social_why_reports SET reason = reason WHERE FALSE": [],
      "DELETE FROM social_why_reports WHERE FALSE": [],
      "SELECT count(*) FROM social_intents": ["blast_web", "blast_watcher"],
      // Financial facts remain planner/indexer-owned; executor progress is a separate relation.
      "SELECT count(*) FROM presale_daily_plans": ["blast_indexer", "blast_migration", "blast_watcher"],
      "INSERT INTO presale_daily_plans SELECT * FROM presale_daily_plans WHERE FALSE": ["blast_indexer", "blast_migration"],
      "UPDATE presale_daily_plans SET plan_id = plan_id WHERE FALSE": ["blast_indexer", "blast_migration"],
      "DELETE FROM presale_daily_plans WHERE FALSE": ["blast_indexer", "blast_migration"],
      "INSERT INTO presale_daily_executions SELECT * FROM presale_daily_executions WHERE FALSE": ["blast_indexer", "blast_migration"],
      "UPDATE presale_daily_executions SET plan_id = plan_id WHERE FALSE": ["blast_indexer", "blast_migration"],
      "DELETE FROM presale_daily_executions WHERE FALSE": ["blast_indexer", "blast_migration"],
      // The chain tables are the indexer's alone: readers reach chain data only through chain_read_v1.
      "SELECT count(*) FROM coins JOIN pools USING (pool_key)": ["blast_indexer", "blast_migration"],
      "SELECT count(*) FROM watermarks": ["blast_indexer", "blast_migration"],
      "SELECT count(*) FROM deployment_identity": ["blast_indexer", "blast_migration"],
      "SELECT c.symbol, c.creator, p.lifecycle FROM chain_read_v1.coins c JOIN chain_read_v1.pools p USING (pool_key)": [
        "blast_indexer", "blast_migration", "blast_web", "blast_watcher", "blast_social", "blast_replica",
      ],
      "SELECT network, deployment_fingerprint, checkpoint, lag_ms FROM chain_read_v1.watermark": [
        "blast_indexer", "blast_migration", "blast_web", "blast_watcher", "blast_social", "blast_replica",
      ],
      "SELECT coin_type, name, symbol, description, icon_url, decimals FROM chain_read_v1.coin_metadata": [
        "blast_indexer", "blast_migration", "blast_web", "blast_watcher", "blast_social", "blast_replica",
      ],
      "UPDATE chain_read_v1.coin_metadata SET symbol = symbol WHERE FALSE": ["blast_indexer", "blast_migration"],
      "DELETE FROM coins WHERE FALSE": ["blast_indexer", "blast_migration"],
      "UPDATE pools SET lifecycle = lifecycle WHERE FALSE": ["blast_indexer", "blast_migration"],
      "DELETE FROM chain_read_v1.coins WHERE FALSE": ["blast_indexer", "blast_migration"],
      "CREATE TABLE role_probe (id INT)": ["blast_indexer", "blast_migration"],
      "CREATE VIEW chain_read_v1.role_probe AS SELECT 1": ["blast_indexer", "blast_migration"],
    };
    const observed: Record<string, Role[]> = {};
    for (const [sql, allowed] of Object.entries(operations)) {
      observed[sql] = [];
      for (const role of ROLES) {
        const outcome = await attempt(admin, role, sql);
        if (outcome === "ok") observed[sql].push(role);
        else assert.equal(outcome, "42501", `${role}: ${sql}: refused by PostgreSQL privileges`);
      }
      assert.deepEqual(observed[sql], allowed, sql);
    }
  } finally {
    await admin.end();
  }
});

test("as the web runtime, a revoked API key can be revoked again but never un-revoked or re-attributed", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const client = await admin.connect();
  try {
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    await migrateDatabase(admin);
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE blast_web");
    const id = "00000000-0000-4000-8000-0000000000a1";
    await client.query(
      `INSERT INTO presale_api_keys (id, label, key_hash, issued_by)
       VALUES ($1, 'revocation-probe', sha256('revocation-probe'::bytea), 'operator:ops-a')`,
      [id],
    );
    const revoke = `UPDATE presale_api_keys
      SET revoked_at = coalesce(revoked_at, now()), revoked_by = coalesce(revoked_by, $2)
      WHERE id = $1 RETURNING revoked_by`;
    assert.deepEqual((await client.query(revoke, [id, "operator:ops-a"])).rows, [{ revoked_by: "operator:ops-a" }]);
    /** Runs `sql` on the real revoked row in a savepoint: "ok" or the SQLSTATE and constraint that refused it. */
    const probe = async (sql: string, values: unknown[] = []): Promise<string> => {
      await client.query("SAVEPOINT probe");
      try {
        await client.query(sql, values);
        await client.query("RELEASE SAVEPOINT probe");
        return "ok";
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT probe");
        const { code, constraint } = error as { code?: string; constraint?: string };
        return `${code}:${constraint}`;
      }
    };
    const final = "23514:presale_api_keys_revocation_final";
    // The repository's repeat revoke writes the same values back: still allowed.
    assert.equal(await probe(revoke, [id, "operator:ops-b"]), "ok", "a repeat revoke keeps working");
    assert.equal(await probe("UPDATE presale_api_keys SET revoked_at = revoked_at, revoked_by = revoked_by WHERE id = $1", [id]), "ok");
    // Un-revoking, re-attributing or re-dating a revoked key is refused by the database itself.
    assert.equal(await probe("UPDATE presale_api_keys SET revoked_at = NULL, revoked_by = NULL WHERE id = $1", [id]), final, "un-revoke");
    assert.equal(await probe("UPDATE presale_api_keys SET revoked_by = 'operator:ops-b' WHERE id = $1", [id]), final, "revoker rewrite");
    assert.equal(await probe("UPDATE presale_api_keys SET revoked_at = revoked_at + interval '1 second' WHERE id = $1", [id]), final, "re-dated");
    const row = await client.query("SELECT revoked_at IS NOT NULL AS revoked, revoked_by FROM presale_api_keys WHERE id = $1", [id]);
    assert.deepEqual(row.rows, [{ revoked: true, revoked_by: "operator:ops-a" }]);
    assert.equal(
      (await client.query("SELECT count(*)::int AS n FROM presale_api_keys WHERE id = $1 AND revoked_at IS NULL", [id])).rows[0].n,
      0,
      "the key stays inactive",
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await admin.end();
  }
});

test("workload pools reach their roles: writes on the primary role, chain joins on the replica role", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const settings = {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 500,
    max: 2,
    statementTimeoutMs: 2_000,
  };
  const primary = createRuntimePool(urlAs(databaseUrl, "blast_web"), settings);
  const replica = createRuntimePool(urlAs(databaseUrl, "blast_replica"), settings, "blast-replica");
  const watcher = createRuntimePool(urlAs(databaseUrl, "blast_watcher"), { ...settings, max: 2 }, "blast-watcher");
  try {
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    await migrateDatabase(admin);

    assert.equal((await primary.query("SELECT current_user AS role")).rows[0]?.role, "blast_web");
    assert.equal((await replica.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");

    // The web runtime creates a season (its trigger creates the crew sequence) and draws from it.
    await primary.query("INSERT INTO mission_control_seasons (season_id) VALUES ('season-roles')");
    const drawn = await primary.query<{ crew_number: string }>(
      "SELECT mission_control_draw_crew_number('season-roles') AS crew_number",
    );
    assert.equal(drawn.rows[0]?.crew_number, "1");

    const identity = await replica.query(
      `SELECT c.coin_type, c.symbol, c.name, c.icon_url, c.creator, c.pool_key, p.venue, p.pool_id, p.lifecycle,
              c.created_at_ms
       FROM chain_read_v1.coins c JOIN chain_read_v1.pools p USING (pool_key)`,
    );
    assert.deepEqual(identity.rows, [{
      coin_type: "0x1::meme::MEME",
      symbol: "MEME",
      name: "Meme",
      icon_url: "https://i/meme.png",
      creator: "0xc0ffee",
      pool_key: "blast_curve:0xpool",
      venue: "blast_curve",
      pool_id: "0xpool",
      lifecycle: "live",
      created_at_ms: "1790000000000",
    }]);
    await assert.rejects(
      replica.query("SELECT count(*) FROM mission_control_profiles"),
      { code: "42501" },
    );
    await assert.rejects(replica.query("SELECT count(*) FROM coins"), { code: "42501" });
    await assert.rejects(primary.query("DELETE FROM coins WHERE FALSE"), { code: "42501" });

    // The worker's pool: candidates from chain_read_v1 on the primary, its own tables, nothing of the web's.
    assert.equal((await watcher.query("SELECT current_user AS role")).rows[0]?.role, "blast_watcher");
    const candidates = await watcher.query("SELECT coin_type, created_checkpoint FROM chain_read_v1.coins");
    assert.equal(candidates.rowCount, 1);
    await watcher.query("SELECT count(*) FROM mission_control_coin_registrations");
    // Ready launches from chain_read_v1.pools, beside its own migration records.
    await watcher.query("SELECT pool_id, lifecycle FROM chain_read_v1.pools WHERE lifecycle = 'migration_ready'");
    await watcher.query("SELECT count(*) FROM mission_control_launch_migrations");
    await assert.rejects(primary.query("SELECT count(*) FROM mission_control_launch_migrations"), { code: "42501" });
    await assert.rejects(watcher.query("SELECT count(*) FROM coins"), { code: "42501" });
    await assert.rejects(watcher.query("SELECT count(*) FROM mission_control_profiles"), { code: "42501" });
    await assert.rejects(primary.query("SELECT count(*) FROM mission_control_worker_leases"), { code: "42501" });
  } finally {
    await Promise.all([admin.end(), primary.end(), replica.end(), watcher.end()]);
  }
});

test("an open indexer batch on the chain tables takes no lock a web write waits on, in the same database", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const web = createRuntimePool(urlAs(databaseUrl, "blast_web"), {
    connectionTimeoutMs: 2_000,
    idleInTransactionMs: 5_000,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 300,
    max: 1,
    statementTimeoutMs: 1_000,
  });
  const backfill = await admin.connect();
  try {
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    await migrateDatabase(admin);

    // One throttled batch of blast-infra's replay, as its own role, left open.
    await backfill.query("BEGIN");
    await backfill.query("SET LOCAL ROLE blast_indexer");
    await backfill.query(
      `INSERT INTO coins (coin_type, decimals, launcher, created_checkpoint, created_at_ms)
       SELECT '0xbackfill' || n || '::meme::MEME', 9, '0x1', n, n FROM generate_series(1, 500) AS n`,
    );

    // The web pool's 300 ms lock_timeout (55P03) would fail this write if the
    // batch held a lock it needed.
    await withTransaction(web, (transaction) =>
      transaction.forModule("season").write(
        "mission_control_seasons",
        "INSERT INTO mission_control_seasons (season_id) VALUES ('season-backfill')",
      ),
    );
    await backfill.query("COMMIT");

    const counts = await admin.query<{ coins: string; seasons: string }>(
      `SELECT (SELECT count(*) FROM coins) AS coins,
              (SELECT count(*) FROM mission_control_seasons WHERE season_id = 'season-backfill') AS seasons`,
    );
    assert.deepEqual(counts.rows[0], { coins: "501", seasons: "1" }, "one database holds both");
  } finally {
    await backfill.query("ROLLBACK").catch(() => undefined);
    backfill.release();
    await Promise.all([admin.end(), web.end()]);
  }
});

/**
 * The last migration applied while production's owner could still hand objects in `public` to
 * `blast_indexer` and `blast_watcher` (0106, 0107, 0117). Those rights are gone now: blast-infra's
 * engine-schema migration revokes all of `blast_indexer`'s rights on `public`, neither role may
 * create there, and the owner login can no longer SET `blast_watcher`. Every later migration must
 * apply without them.
 */
const LAST_MIGRATION_WITH_HANDOFF_RIGHTS = "0117_standalone_vault_rewards";
const OWNER_LOGIN = "blast_rehearsal_owner";

test("migrations after 0117 apply as production's non-superuser owner login, with production's current privileges", { skip }, async () => {
  assert.ok(databaseUrl);
  const admin = createPool(databaseUrl, { max: 2 });
  const { database, superuser } = (await admin.query<{ database: string; superuser: string }>(
    "SELECT current_database() AS database, current_user AS superuser",
  )).rows[0]!;
  const password = randomUUID();
  const url = new URL(databaseUrl);
  url.username = OWNER_LOGIN;
  url.password = password;
  const owner = createPool(url.toString(), { max: 2 });
  try {
    await resetSharedDatabase(admin);
    await admin.query(CHAIN_FIXTURE);
    // A superuser may hand any object to any role, so the production failure only shows for a
    // login shaped like Neon's `neondb_owner`: no superuser, but CREATEROLE, CREATEDB and
    // BYPASSRLS, owner of the database, and ADMIN on every shared role. It inherits and can SET
    // `blast_indexer` and `blast_migration`, and inherits `blast_watcher`.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${OWNER_LOGIN}') THEN CREATE ROLE ${OWNER_LOGIN}; END IF;
    END $$`);
    await admin.query(`ALTER ROLE ${OWNER_LOGIN} LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS PASSWORD '${password}'`);
    await admin.query(`GRANT blast_indexer, blast_migration TO ${OWNER_LOGIN} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    await admin.query(`GRANT blast_watcher TO ${OWNER_LOGIN} WITH ADMIN TRUE, INHERIT TRUE, SET TRUE`);
    await admin.query(`GRANT blast_web, blast_social, blast_replica TO ${OWNER_LOGIN} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`);
    // Earlier cases create this cluster-wide role. Match the operator's ADMIN
    // authority without pregranting the SET permission migration 0159 must add.
    await admin.query(`DO $$ BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname='blast_analytics_identity_owner') THEN
        GRANT blast_analytics_identity_owner TO ${OWNER_LOGIN} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
      END IF;
    END $$`);
    await admin.query(`ALTER DATABASE "${database}" OWNER TO ${OWNER_LOGIN}`);
    await admin.query("GRANT CREATE ON SCHEMA public TO blast_watcher");

    const before = await migrateDatabase(owner, { through: LAST_MIGRATION_WITH_HANDOFF_RIGHTS });
    assert.equal(before.at(-1), LAST_MIGRATION_WITH_HANDOFF_RIGHTS);
    // Production today.
    await admin.query("REVOKE ALL ON SCHEMA public FROM blast_indexer");
    await admin.query("REVOKE CREATE ON SCHEMA public FROM blast_watcher");
    await admin.query(`REVOKE SET OPTION FOR blast_watcher FROM ${OWNER_LOGIN}`);
    const after = await migrateDatabase(owner);
    assert.equal(after[0], "0118_utility_vesting");
    assert.deepEqual(await migrateDatabase(owner), [], "rerunnable");

    const privileges = (await admin.query<{ indexer_create: boolean; indexer_usage: boolean; watcher_create: boolean }>(
      `SELECT has_schema_privilege('blast_indexer', 'public', 'CREATE') AS indexer_create,
              has_schema_privilege('blast_indexer', 'public', 'USAGE') AS indexer_usage,
              has_schema_privilege('blast_watcher', 'public', 'CREATE') AS watcher_create`,
    )).rows[0];
    assert.deepEqual(privileges, { indexer_create: false, indexer_usage: true, watcher_create: false }, "as in production: USAGE through PUBLIC, no CREATE");
    // 0138 hands its manifest function to blast_indexer; 0157 drops it again through the login's
    // blast_indexer membership, with the other retired reward readers.
    const retired = await admin.query<{ proname: string }>(
      `SELECT proname FROM pg_proc WHERE proname IN ('launch_published_daily_manifest', 'presale_published_daily_manifest',
         'presale_daily_waiting_rewards', 'vault_daily_waiting_rewards')`,
    );
    assert.deepEqual(retired.rows, [], "the non-superuser migration login drops the blast_indexer-owned reward readers");
    assert.deepEqual((await owner.query(`SELECT
      pg_has_role(current_user,'blast_analytics_identity_owner','SET') AS can_set,
      pg_has_role(current_user,'blast_analytics_identity_owner','USAGE') AS inherits`)).rows,
    [{ can_set: true, inherits: false }]);
    const identitySql = (direction: string) => readFile(new URL(`./migrations/0159_analytics_identity.${direction}.sql`, import.meta.url), "utf8");
    await owner.query(await identitySql("down"));
    assert.equal((await owner.query("SELECT to_regprocedure('public.analytics_account_id(text,text)') AS function")).rows[0].function, null);
    await owner.query(await identitySql("up"));
    assert.equal((await owner.query("SELECT current_user AS role")).rows[0].role, OWNER_LOGIN, "ownership maintenance restores the caller");
  } finally {
    await admin.query(`ALTER DATABASE "${database}" OWNER TO "${superuser}"`).catch(() => undefined);
    await Promise.all([owner.end(), admin.end()]);
  }
});
