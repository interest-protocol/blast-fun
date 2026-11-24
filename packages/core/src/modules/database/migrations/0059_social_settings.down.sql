DROP VIEW IF EXISTS social_account_callsigns;
DROP INDEX IF EXISTS social_presale_embedded_wallets_address_idx;
DROP TABLE IF EXISTS social_notification_preferences;
ALTER TABLE social_accounts
  DROP COLUMN IF EXISTS explorer,
  DROP COLUMN IF EXISTS portfolio_public;
