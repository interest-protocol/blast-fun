-- Back to 0160: the column returns with its old default; earlier values are not restored.
ALTER TABLE social_accounts
  ADD COLUMN commit_too_amount_usd NUMERIC(12, 2) NOT NULL DEFAULT 50 CHECK (commit_too_amount_usd > 0);
