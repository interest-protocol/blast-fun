-- The Settings "Default amount" is gone (#1026): amount boxes start empty
-- (#1012) and no deployed code reads or writes `commit_too_amount_usd`, so
-- the column and its check go.
-- Fail fast rather than queue account reads behind a long transaction.
SET LOCAL lock_timeout = '3s';
ALTER TABLE social_accounts DROP COLUMN commit_too_amount_usd;
