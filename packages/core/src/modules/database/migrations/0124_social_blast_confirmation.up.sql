-- Account-owned preference; table grants already cover the existing Settings route.
-- A constant default preserves existing accounts' immediate Blast Mode actions.
ALTER TABLE social_accounts
  ADD COLUMN blast_mode_confirm_actions BOOLEAN NOT NULL DEFAULT false;
