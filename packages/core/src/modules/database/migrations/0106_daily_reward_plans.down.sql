DROP INDEX presale_daily_refresh_work;
DROP FUNCTION presale_daily_waiting_rewards(TEXT,TEXT,TEXT[]);
DROP FUNCTION presale_refresh_unsigned_publication(UUID,UUID,TEXT);
DROP FUNCTION presale_daily_gas_work_pending(UUID);
REVOKE SELECT,INSERT ON presale_outbox_actions FROM blast_indexer;
DROP FUNCTION presale_published_daily_manifest(TEXT);
DROP TABLE presale_daily_round_status,presale_daily_gas_prices,presale_daily_gas_effects,presale_daily_deliveries,presale_daily_executions;
DROP TABLE presale_quote_reservations,presale_daily_hashes,presale_daily_allocations,presale_daily_plans,presale_daily_periods,presale_daily_vaults;
DROP FUNCTION presale_daily_immutable();
DROP FUNCTION presale_daily_execution_immutable();
DROP FUNCTION presale_daily_terminal_evidence();

DROP FUNCTION presale_daily_period_immutable();
