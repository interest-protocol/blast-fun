REVOKE UPDATE (next_poll_at, observed_from, circle_not_found_at) ON TABLE presale_bridge_transfers FROM blast_web;
ALTER TABLE presale_bridge_transfers
  DROP CONSTRAINT IF EXISTS presale_bridge_transfers_observed_from_check,
  DROP COLUMN IF EXISTS observed_from,
  DROP COLUMN IF EXISTS circle_not_found_at;
