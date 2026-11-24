-- Ordered account-only indexes support keyset pages in both directions.
-- The UUID expression matches the following cursor; presale IDs are excluded.
-- The migration runner uses a transaction, so these cannot be CONCURRENTLY.
-- CREATE INDEX holds a SHARE lock and blocks follow writes while it builds.
CREATE INDEX social_follows_followers_page_idx
  ON social_follows (target_id, created_at DESC, follower_account_id DESC)
  WHERE target_kind = 'account';

CREATE INDEX social_follows_following_page_idx
  ON social_follows (follower_account_id, created_at DESC, (target_id::uuid) DESC)
  WHERE target_kind = 'account';
