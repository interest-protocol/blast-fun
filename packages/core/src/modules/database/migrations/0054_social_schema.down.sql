REVOKE SELECT ON TABLE mission_control_account_wallets, mission_control_account_identities, presale_embedded_wallets
FROM blast_watcher, blast_replica;

DROP VIEW IF EXISTS social_wallet_owners;
DROP TRIGGER IF EXISTS mission_control_profiles_social_callsign_guard ON mission_control_profiles;
DROP TABLE IF EXISTS social_worker_state;
DROP TABLE IF EXISTS social_operator_log;
DROP TABLE IF EXISTS social_blocked_terms;
DROP TABLE IF EXISTS social_config;
DROP TABLE IF EXISTS social_attributions;
DROP TABLE IF EXISTS social_intents;
DROP TABLE IF EXISTS social_reactions;
DROP TABLE IF EXISTS social_why_reports;
DROP TABLE IF EXISTS social_whys;
DROP TABLE IF EXISTS social_milestones;
DROP TABLE IF EXISTS social_default_accounts;
DROP TABLE IF EXISTS social_follows;
DROP TABLE IF EXISTS social_account_wallets;
DROP TABLE IF EXISTS social_accounts;
DROP FUNCTION IF EXISTS social_reject_taken_callsign();
DROP FUNCTION IF EXISTS social_refuse_rewrite();
