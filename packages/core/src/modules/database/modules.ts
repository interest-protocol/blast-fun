export const MISSION_CONTROL_MODULES = [
  "profile",
  "account",
  "season",
  "invitation",
  "provider",
  "wallet-challenge",
  "web-security",
  "session",
  "completion",
  "operator",
  "card",
  "campaign-event",
  "read-model",
  "x-verification",
  // Launchpad outcome telemetry: first coin views, verified outcomes and their visitors' digest commitments.
  "launchpad-telemetry",
  // Launchpad identity: Wallet Proof challenges for protected launchpad writes.
  "launchpad-identity",
  "launchpad-discovery",
  // Read-only: chain joins over blast-infra's `chain_read_v1` views and the replica lag probe.
  "chain-read",
  // Shared worker runtime (`blast_watcher`): leases, job state, open submissions.
  "worker-runtime",
  "presale-outbox",
  "presale-planner",
  // The worker's Coin Registry registration job (`blast_watcher` only).
  "coin-registration",
  // The worker's automatic launch migration job (`blast_watcher` only).
  "launch-migration",
  // The worker's opening-round keeper: settle and deliver (`blast_watcher` only, LP-18).
  "opening-round",
  // The worker's Blast and partner fee claims (`blast_watcher` only, LP-20).
  "fee-claims",
  // Buyback vault schedule and its identity-bound human release gate.
  "vault-buyback",
  "blast-keeper",
  "rewards-planner",
  "vault-rewards",
  // Launchpad social records: author identities, immutable posts, their moderation and search materialization.
  "launchpad-social",
  // Presale (T-008): the Privy DID → embedded Sui wallet cache.
  "presale-embedded-wallets",
  // Presale (T-017): verified commit outcomes and their visitors' digest commitments.
  "presale-outcomes",
  // Presale (T-010): each Privy account's explorer and theme.
  "presale-settings",
  // Presale (T-013): allowlist manifests and their entries with stored proofs.
  "presale-allowlists",
  // Presale (T-013): agent API keys, by SHA-256 only.
  "presale-api-keys",
  "partner-api-keys",
  // Presale (T-009): the presale workers' release gate and alert state (`blast_watcher` reads the gate, owns the alerts).
  "presale-worker",
  // Presale (T-020): the CCTP bridge's transfer registry and activation records.
  "presale-bridge",
  // Presale (T-016): sponsored gas reservations and target refusal counts.
  "presale-sponsor",
  // Presale (T-012): the catalog of rendered receipt images.
  "presale-receipts",
  // Presale (T-014): which allowlist manifest serves each presale's proofs.
  "presale-allowlist-bindings",
  // Presale (T-023): the lifecycle relayer's per-sale settle and migrate records (`blast_watcher` only).
  "presale-lifecycle",
  // Social feed (T-001): accounts, follows, whys, reactions, intents, attributions, milestones and their
  // operator state, with the wallet-owner and feed-entry views (migrations 0054, 0055).
  "social",
] as const;

export type MissionControlModule = (typeof MISSION_CONTROL_MODULES)[number];

export const TABLE_OWNERSHIP = {
  profile: [
    "mission_control_profiles",
    "mission_control_reserved_callsigns",
    "mission_control_callsign_attempt_limits",
  ],
  account: [
    "mission_control_account_identities",
    "mission_control_account_wallets",
  ],
  season: [
    "mission_control_seasons",
    "mission_control_season_memberships",
  ],
  invitation: [
    "mission_control_seed_creators",
    "mission_control_seed_code_groups",
    "mission_control_invitation_codes",
    "mission_control_admission_attempts",
    "mission_control_admission_failures",
  ],
  provider: ["mission_control_provider_connections"],
  "wallet-challenge": ["mission_control_wallet_challenges"],
  "web-security": [
    "mission_control_oauth_states",
    "mission_control_rate_limit_windows",
    "mission_control_abuse_decision_audit",
  ],
  session: ["mission_control_member_sessions"],
  completion: [
    "mission_control_invitation_allocations",
    "mission_control_referrals",
    "mission_control_seed_creator_attributions",
    "mission_control_completion_idempotency",
  ],
  operator: [
    "mission_control_operator_actions",
    "mission_control_operator_action_events",
  ],
  card: ["mission_control_cards", "mission_control_card_images"],
  "campaign-event": ["mission_control_campaign_events"],
  "read-model": [
    "mission_control_projection_checkpoints",
    "mission_control_projection_deliveries",
    "mission_control_owner_projection",
    "mission_control_telemetry_projection",
    "mission_control_campaign_telemetry_projection",
    "mission_control_campaign_telemetry_blastoff_facts",
  ],
  "x-verification": [
    "mission_control_x_verification_jobs",
    "mission_control_provider_backoff",
  ],
  "launchpad-telemetry": [
    "mission_control_launchpad_coin_views",
    "mission_control_launchpad_outcomes",
    "mission_control_launchpad_outcome_commitments",
  ],
  "launchpad-identity": ["mission_control_launchpad_wallet_challenges"],
  "launchpad-discovery": ["mission_control_bonding_feature"],
  "chain-read": [],
  "worker-runtime": [
    "mission_control_worker_leases",
    "mission_control_worker_jobs",
    "mission_control_worker_submissions",
    "blast_worker_alerts",
    "blast_worker_release_gate_checks",
  ],
  "presale-outbox": ["presale_outbox_actions", "presale_outbox_attempts", "presale_outbox_prepared_inputs", "presale_outbox_input_objects", "presale_outbox_input_reservations", "presale_daily_deliveries", "presale_daily_gas_effects", "presale_daily_round_status"],
  "presale-planner": ["presale_daily_vaults", "presale_daily_periods", "presale_daily_plans", "presale_daily_allocations", "presale_daily_hashes", "presale_quote_reservations", "presale_daily_executions", "presale_daily_gas_prices"],
  "coin-registration": ["mission_control_coin_registrations"],
  "launch-migration": ["mission_control_launch_migrations"],
  "opening-round": ["mission_control_opening_rounds"],
  "fee-claims": ["mission_control_fee_claims"],
  "vault-buyback": ["mission_control_vault_buybacks"],
  "blast-keeper": ["blast_keeper_actions"],
  "rewards-planner": [
    "vault_reward_periods", "vault_reward_plans", "vault_reward_holders", "vault_reward_allocations", "vault_reward_hashes",
    // blast-infra's writer of holder identity answers (address_identity); only the planner's role may call it.
    "chain_read_v1.record_address_identities",
  ],
  "vault-rewards": ["vault_reward_actions", "vault_reward_gas_effects"],
  "launchpad-social": [
    "mission_control_launchpad_social_authors",
    "mission_control_launchpad_theses",
    "mission_control_launchpad_thesis_moderation",
    "mission_control_launchpad_search_documents",
  ],
  "presale-embedded-wallets": ["presale_embedded_wallets"],
  "presale-outcomes": ["presale_outcomes", "presale_outcome_commitments"],
  "presale-settings": ["presale_account_settings"],
  "presale-allowlists": ["presale_allowlists", "presale_allowlist_entries"],
  "presale-api-keys": ["presale_api_keys"],
  "partner-api-keys": ["partner_api_partners", "partner_api_keys", "partner_api_key_policy_events", "partner_api_deletion_events", "partner_api_recognition"],
  "presale-worker": ["presale_release_gate_checks"],
  "presale-bridge": ["presale_bridge_transfers", "presale_bridge_activations"],
  "presale-sponsor": ["presale_sponsor_reservations", "presale_sponsor_refusal_counts", "presale_sponsor_budget_attempts"],
  "presale-receipts": ["presale_receipt_images"],
  "presale-allowlist-bindings": ["presale_allowlist_bindings"],
  "presale-lifecycle": ["presale_lifecycle_records"],
  social: [
    "presale_reward_blacklists",
    "social_blast_workspaces",
    "social_blast_workspace_writers",
    "social_presale_pins",
    "social_accounts",
    "social_account_wallets",
    "social_follows",
    "social_default_accounts",
    "social_milestones",
    "social_whys",
    "social_why_reports",
    "social_reactions",
    "social_intents",
    "social_attributions",
    "social_config",
    "social_blocked_terms",
    "social_operator_log",
    "social_worker_state",
    "social_wallet_balance_requests",
    // 0058 (UI-08 sign-in): wallet sign-in sessions.
    "social_wallet_sessions",
    // 0059 (UI-07 settings): the seven notification switches.
    "social_notification_preferences",
    // 0064 (UI-13 notifications): one row per notification per recipient.
    "social_notifications",
    "social_notification_reads",
    // 0068 (UI-20 create): each account's presale drafts.
    "social_presale_drafts",
    "social_presale_publish_approvals",
    "social_presale_raise_floor_rollout",
    // 0146 (/launch): each account's bonding-curve launch drafts and the published launch's details.
    "social_launch_drafts",
    // 0072 (UI-12 search and watchlist): each account's starred presales.
    "social_watchlist",
    // 0075 (UI-14 coins): the audit record of each withdrawal from a Blast wallet.
    "social_coin_transfers",
    // 0084 (R3-27): the per-account transaction log, written by every money path.
    "social_transactions",
    "social_vesting_attempts",
    // 0088 (R3-23): a sale's trust flags; the audited flag by the operator CLI, the verified mark (0165) by the admin website.
    "social_sale_trust",
    // 0164 (R3-23): a bonding-curve coin's verified-team flag, written only by the admin website (0165).
    "social_coin_trust",
    // 0089 (R3-31): each trade an account sends, from its pinned quote to its outcome.
    "social_swap_intents",
    "social_swap_receipts",
    "social_referral_reservations",
    "social_referral_entities",
    "social_referral_events",
    "social_competitions",
    // 0090 (R3-24): a sale's public details (cover, tagline, links, launch date) and their insert-only edit log.
    "social_sale_metadata",
    "social_sale_metadata_edits",
    // 0097 (OA-25 Q16): each account's daily portfolio value, written by the social worker.
    "social_portfolio_snapshots",
    "social_portfolio_balance_observations",
    "social_portfolio_source_revision",
    // 0100 (withdraw to another chain): each CCTP withdrawal out of a Blast wallet, from its burn to Circle's mint.
    "social_bridge_withdrawals",
    "social_bridge_withdraw_claims",
    // 0135: each account's creator-recipient commitment, minted once.
    "social_creator_commitments",
    // Read-only views: PostgreSQL refuses a write to any of them.
    "social_wallet_owners",
    "social_feed_entries",
    "social_published_presales",
    "social_account_identities",
    "social_account_callsigns",
    "social_callsign_aliases",
    // 0072: who search may find (public accounts and members), with their public identity.
    "social_account_search",
  ],
} as const satisfies Record<MissionControlModule, readonly string[]>;

export type OwnedTable<M extends MissionControlModule> =
  (typeof TABLE_OWNERSHIP)[M][number];

export function isOwnedTable<M extends MissionControlModule>(
  moduleName: M,
  table: string,
): table is OwnedTable<M> {
  return (TABLE_OWNERSHIP[moduleName] as readonly string[]).includes(table);
}

export function assertTableOwnership(
  moduleName: MissionControlModule,
  table: string,
): void {
  if (!isOwnedTable(moduleName, table)) {
    throw new Error(
      `Mission Control module "${moduleName}" cannot write table "${table}".`,
    );
  }
}

/** The schema-qualified writing functions a module owns: a read may not call one. */
const OWNED_FUNCTIONS = Object.values(TABLE_OWNERSHIP).flat().filter((name) => name.includes("."));

/** Refuses a read that calls an owned writing function; best-effort, the grants are the boundary. */
export function assertNoOwnedFunctionCall(text: string): void {
  const called = OWNED_FUNCTIONS.find((name) => new RegExp(`\\b${name.replace(".", "\\s*\\.\\s*")}\\s*\\(`, "i").test(text));
  if (called) throw new Error(`Reads cannot call ${called}; use its owning module's write.`);
}

/**
 * blast-infra's chain tables in the shared database (its migrations
 * `2026-09-30-000000_database_roles` and `2026-09-30-100000_chain_read_views`,
 * with the framework's `watermarks`), as of blast-infra
 * `lst/T-003-1@0de1de7`. No web module reads or writes them: PostgreSQL
 * grants the web roles nothing on them. This copy drifts when blast-infra adds
 * a chain table; the grants do not.
 */
export const BLAST_INFRA_TABLES = [
  "message_cursors", "message_checkpoints", "chain_events", "coins", "pools", "lifecycle_changes",
  "trades", "candles_1m", "candles_1d", "pool_totals", "balance_changes", "balances", "positions",
  "dex_swap_volume", "dex_swap_volume_coverage", "dex_swap_volume_tracked_coverage",
  "position_baselines", "wallet_totals", "usd_prices", "admitted_quotes", "archive_cuts", "job_runs",
  "watermarks", "__diesel_schema_migrations", "deployment_identity",
  "checkpoint_journal", "native_transactions", "native_events", "projection_faults",
  "balance_history_coverage", "native_identity_history", "balance_history_faults", "native_balance_changes",
  "balance_integrals", "balance_integral_accounts", "holder_quote_movements",
  "wallet_tracking", "wallet_balances", "wallet_snapshot_coins", "wallet_coin_types",
  "vaults", "vault_fee_collections", "vault_rounds", "protocol_fee_ledgers", "protocol_fee_payments", "partner_earnings", "partner_lists", "partner_terms", "delayed_values", "delayed_set_members", "stack_packages", "stack_objects", "pool_tiers", "quote_allowed", "meme_decimals_allowed",
  "financial_price_coverage", "financial_quote_configs", "financial_feed_observations", "financial_pool_observations",
  "address_identity",
] as const;

/**
 * The versioned chain read views blast-infra publishes and grants application
 * readers SELECT on. The fresh unpublished stack replaces its chain-derived projections in place
 * under `chain_read_v1` (contracts ADR 0137).
 */
export const CHAIN_READ_VIEWS = [
  "chain_read_v1.checkpoint_headers",
  // Receipt replay has its own blast_defillama_source role.
  "chain_read_v1.defillama_events",
  "chain_read_v1.launch_activity",
  "chain_read_v1.reward_holder_window_since",
  // The holders of a reward page whose identity is not yet proven through its cut.
  "chain_read_v1.reward_identity_gaps",
  "chain_read_v1.usd_observation",
  "chain_read_v1.vaults",
  "chain_read_v1.vault_fee_collections",
  "chain_read_v1.vault_rounds",
  "chain_read_v1.protocol_fee_ledgers",
  "chain_read_v1.protocol_fee_payments",
  "chain_read_v1.partner_earnings",
  "chain_read_v1.partner_lists",
  "chain_read_v1.partner_terms",
  "chain_read_v1.delayed_values",
  "chain_read_v1.delayed_set_members",
  "chain_read_v1.stack_packages",
  "chain_read_v1.stack_objects",
  "chain_read_v1.pool_tiers",
  "chain_read_v1.quote_allowed",
  "chain_read_v1.meme_decimals_allowed",

  "chain_read_v1.vault_reward_payouts",
  "chain_read_v1.lifecycle_planning",
  "chain_read_v1.projection_coverage",
  "chain_read_v1.transaction_evidence",
  "chain_read_v1.coins",
  "chain_read_v1.coin_metadata",
  "chain_read_v1.presale_coin_supply",
  "chain_read_v1.coin_unavailable",
  "chain_read_v1.pools",
  "chain_read_v1.watermark",
  // The rebuilt indexer's presale and activity contract (social-feed T-001).
  "chain_read_v1.activity",
  "chain_read_v1.dex_swap_volume",
  "chain_read_v1.dex_swap_volume_coverage",
  "chain_read_v1.dex_swap_volume_tracked_coverage",
  "chain_read_v1.blast_pnl_activity",
  "chain_read_v1.blast_pnl_period",
  "chain_read_v1.presale_lifecycle",
  "chain_read_v1.presales",
  "chain_read_v1.presale_positions",
  "chain_read_v1.coin_balances",
  "chain_read_v1.wallet_balances",
  "chain_read_v1.wallet_sync",
  "chain_read_v1.coin_holder_history",
  "chain_read_v1.prices",
  "chain_read_v1.vesting_schedules",
  // R3-20: a coin's bucketed USD price history.
  "chain_read_v1.price_history",
  "chain_read_v1.native_coin_price_at",
  "chain_read_v1.coin_price_in_window",
  "chain_read_v1.presale_pool_prices",
  "chain_read_v1.presale_pool_swaps",
  "chain_read_v1.presale_pool_price_history",
  // Redesign data gap 8: each tracked sale pool's reserves.
  "chain_read_v1.pool_reserves",
  "chain_read_v1.utility_vesting_schedules",
  "chain_read_v1.utility_vesting_events",
] as const;

/** An optional alias: any word but the keywords that can follow a relation. */
const ALIAS = String.raw`(?:\s+(?:as\s+)?(?!(?:join|left|right|inner|outer|full|cross|natural|lateral|on|using|where|group|order|limit|union)\b)\w+)?`;
/** A FROM or JOIN relation with its alias, then any comma-listed relations. */
const RELATIONS = new RegExp(String.raw`\b(?:from|join)\s+([\w."]+)${ALIAS}((?:\s*,\s*[\w."]+${ALIAS})*)`, "gi");

/**
 * Refuses a chain read that names a blast-infra table, a retired `chain_v1`
 * view or an unpublished `chain_read_v1` relation, before it reaches the
 * database. It is a best-effort lint, not the boundary: PostgreSQL's grants
 * are. It reads `FROM`/`JOIN` relations and comma lists only, so it misses
 * `FROM ONLY`, parenthesised or spaced-out names, `LATERAL` and partitions
 * (the grants refuse those), and it refuses a CTE named like a chain table.
 */
export function assertChainReadThroughViews(text: string): void {
  const relations = [...text.matchAll(RELATIONS)].flatMap((match) => [
    match[1],
    ...match[2].split(",").slice(1).map((item) => item.trim().split(/\s+/)[0]),
  ]);
  for (const raw of relations) {
    const relation = raw.replace(/"/g, "").toLowerCase();
    const [schema, name] = relation.includes(".") ? relation.split(".") : ["public", relation];
    const published = (CHAIN_READ_VIEWS as readonly string[]).includes(`${schema}.${name}`);
    const chainSchema = schema.startsWith("chain_") || schema === "blast_infra";
    const chainTable = schema === "public" && (BLAST_INFRA_TABLES as readonly string[]).includes(name);
    if ((chainSchema && !published) || chainTable) {
      throw new Error(`Chain reads name only blast-infra's chain_read_v1 views, not ${relation}.`);
    }
  }
}
