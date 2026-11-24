-- One checkpointed outcome of a transaction built by our frontend's swap API.
-- Sender, coins, input atoms and submission-time USD remain on the immutable intent.
-- Existing intents remain excluded, including ones settled after this migration.
ALTER TABLE social_swap_intents ADD COLUMN track_receipt BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE social_swap_intents ALTER COLUMN track_receipt SET DEFAULT TRUE;
CREATE TABLE social_swap_receipts (
  trade_id UUID PRIMARY KEY REFERENCES social_swap_intents(trade_id),
  timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms > 0),
  checkpoint BIGINT NOT NULL CHECK (checkpoint >= 0),
  success BOOLEAN NOT NULL,
  amount_out NUMERIC(20, 0) CHECK (amount_out > 0 AND amount_out <= 18446744073709551615),
  CHECK (success = (amount_out IS NOT NULL))
);
CREATE INDEX social_swap_intents_tracking_idx ON social_swap_intents(created_at_ms, trade_id) WHERE digest IS NOT NULL AND track_receipt;
CREATE INDEX social_swap_receipts_time_idx ON social_swap_receipts(timestamp_ms, trade_id);
REVOKE ALL ON social_swap_receipts FROM PUBLIC;
GRANT SELECT, INSERT ON social_swap_receipts TO blast_web;
-- Deliberately no replica grant: frontend wallet activity stays on the primary.
