-- Down: saved curve coins are removed, then the check takes sales only again.
SET LOCAL lock_timeout = '3s';
DELETE FROM social_watchlist WHERE presale_id !~ '^0x[0-9a-f]{64}$';
ALTER TABLE social_watchlist DROP CONSTRAINT social_watchlist_presale_id;
ALTER TABLE social_watchlist ADD CONSTRAINT social_watchlist_presale_id CHECK (presale_id ~ '^0x[0-9a-f]{64}$');
