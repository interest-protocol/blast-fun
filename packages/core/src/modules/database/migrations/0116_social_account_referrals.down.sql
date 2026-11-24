DROP TRIGGER social_accounts_referrer_immutable ON social_accounts;
DROP FUNCTION social_accounts_check_referrer();
DROP INDEX social_accounts_referrer_idx;
ALTER TABLE social_accounts DROP CONSTRAINT social_accounts_no_self_referral, DROP COLUMN referrer_account_id;
