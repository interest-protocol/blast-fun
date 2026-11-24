-- #725: these readers query chain_read_v1.presale_reward_rounds, presale_reward_payouts and
-- launch_reward_rounds, which the fresh-stack indexer dropped (0155 moved the live readers onto
-- vault_rounds and vault_reward_payouts). Nothing calls them, and PL/pgSQL would only fail at call
-- time. All are owned by blast_indexer; the migration login drops them through that membership.
DROP FUNCTION presale_daily_waiting_rewards(TEXT,TEXT,TEXT[]);
DROP FUNCTION presale_published_daily_manifest(TEXT);
DROP FUNCTION vault_daily_waiting_rewards(TEXT,TEXT,TEXT[]);
DROP FUNCTION launch_published_daily_manifest(TEXT);
