-- Account-owned preference; table grants already cover the existing Settings route.
-- Null is each sale's own quote coin, so existing accounts keep paying with it.
ALTER TABLE social_accounts
  ADD COLUMN commit_too_coin_type TEXT
  CHECK (commit_too_coin_type IS NULL OR length(commit_too_coin_type) <= 1024 AND commit_too_coin_type ~ '^0x[0-9a-f]{64}::[A-Za-z0-9_]+::[A-Za-z0-9_]+(<.+>)?$');
