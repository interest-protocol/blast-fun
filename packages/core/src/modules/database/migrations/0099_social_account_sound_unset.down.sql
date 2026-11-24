-- Back to 0093's column: every account has a value and "not chosen" means on,
-- as 0093 defined it. An account that never chose reads `true` again; an
-- explicit choice is kept as it is.
UPDATE social_accounts SET sound = true WHERE sound IS NULL;

ALTER TABLE social_accounts
  ALTER COLUMN sound SET DEFAULT true,
  ALTER COLUMN sound SET NOT NULL;
