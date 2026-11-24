-- Social feed R3-23, bonding-curve coins (Jose 2026-11-20): Blast checked who
-- is behind a curve coin. A sale's flag lives in `social_sale_trust` (0088),
-- keyed by its presale; a curve coin has no presale, so its flag is keyed by
-- its coin type. A row means verified; clearing deletes it.
--
-- Set and cleared only through the operator CLI
-- (`npm run social:operator -- coin trust set|clear <coin_type> --reason`),
-- which runs as the owning migration login and appends one
-- `social_operator_log` row per change in the same transaction: that log is
-- the history. Only a Blast bonding-curve coin can be flagged; a sale's coin
-- keeps using `sale trust`, so each coin has one source.
--
-- The public reads probe this table by primary key for one boolean; the
-- operator, the time and `note` are never served.
CREATE TABLE social_coin_trust (
  coin_type TEXT PRIMARY KEY
    CHECK (length(coin_type) <= 1024 AND coin_type ~ '^0x[0-9a-f]{64}::[A-Za-z0-9_]+::[A-Za-z0-9_]+(<.+>)?$'),
  verified_by TEXT NOT NULL CHECK (char_length(verified_by) BETWEEN 1 AND 200),
  verified_at_ms BIGINT NOT NULL CHECK (verified_at_ms > 0),
  -- Why, for the operator: the reason the set gave. Never served to a browser.
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 1 AND 500)
);

-- `coin trust history <coin_type>`: one coin's changes in the operator log, newest first.
CREATE INDEX social_operator_log_coin_trust_idx ON social_operator_log (target, acted_at DESC, log_id DESC)
  WHERE action IN ('coin.trust.set', 'coin.trust.clear');

-- Written only by the operator CLI (the owner). The web reads it on the primary and the replica.
REVOKE ALL ON TABLE social_coin_trust FROM PUBLIC;
GRANT SELECT ON TABLE social_coin_trust TO blast_web, blast_replica;
