-- Social feed R3-23 (OA-25 Q8): a sale's trust flags. `verified_team` means
-- a person at Blast checked who is behind the project, `audited` that Blast
-- read the audit report. There is no LP-lock flag (OA-26): every Blast
-- migration pool's LP position is locked for good by the contracts, so the
-- lock is stated for every sale and is no per-sale judgement.
-- Each flag is a human judgement, set and cleared only through the operator CLI
-- (`npm run social:operator -- sale trust set|clear <presale_id> … --reason`),
-- which runs as the owning migration login and appends one
-- `social_operator_log` row per change in the same transaction: that
-- append-only log is the history (who, when, why, the flags before and
-- after). This row is the current state.
--
-- Not chain data: `chain_read_v1` is a projection of the chain, additive-only,
-- where a retracted judgement could not be removed (OA-25 settles where the
-- flags live). Never derived from creator input either: an audit link in a
-- sale's metadata (R3-24) sets nothing here.
--
-- A sale with no row reads both flags false. The public presale reads join
-- the two booleans by primary key and nothing else: the operator identity,
-- the times and `note` (the last change's reason) are never served.
CREATE TABLE social_sale_trust (
  presale_id TEXT PRIMARY KEY CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  verified_team BOOLEAN NOT NULL DEFAULT FALSE,
  audited BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by TEXT CHECK (char_length(verified_by) BETWEEN 1 AND 200),
  verified_at_ms BIGINT CHECK (verified_at_ms > 0),
  audited_by TEXT CHECK (char_length(audited_by) BETWEEN 1 AND 200),
  audited_at_ms BIGINT CHECK (audited_at_ms > 0),
  -- Why, for the operator: the reason the last change gave. Never served to a browser.
  note TEXT CHECK (char_length(note) BETWEEN 1 AND 500),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms > 0),
  -- A set flag names who set it and when; a clear flag names nobody.
  CONSTRAINT social_sale_trust_verified_by CHECK (verified_team = (verified_by IS NOT NULL AND verified_at_ms IS NOT NULL)),
  CONSTRAINT social_sale_trust_verified_cleared CHECK (verified_team OR (verified_by IS NULL AND verified_at_ms IS NULL)),
  CONSTRAINT social_sale_trust_audited_by CHECK (audited = (audited_by IS NOT NULL AND audited_at_ms IS NOT NULL)),
  CONSTRAINT social_sale_trust_audited_cleared CHECK (audited OR (audited_by IS NULL AND audited_at_ms IS NULL))
);

-- `sale trust history <presale_id>`: one sale's changes in the operator log, newest first,
-- keyset on (acted_at, log_id). Only the two actions that change a flag.
CREATE INDEX social_operator_log_sale_trust_idx ON social_operator_log (target, acted_at DESC, log_id DESC)
  WHERE action IN ('sale.trust.set', 'sale.trust.clear');

-- Written only by the operator CLI (the owner): no runtime role inserts, updates or deletes a row.
-- The web runtime reads it on the primary (the watchlist, the viewer's reads) and the replica on
-- the public presale reads.
REVOKE ALL ON TABLE social_sale_trust FROM PUBLIC;
GRANT SELECT ON TABLE social_sale_trust TO blast_web, blast_replica;
