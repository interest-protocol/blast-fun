-- Social feed R3-63: the claim transaction's open attempts get their own
-- access path in the transaction log (0084).
--
-- A claim is logged `submitted` by PUT /api/social/me/claims/{request_id}
-- before the wallet signs it, and settled by the same route from the
-- fullnode once the browser sends its digest. A browser that never comes
-- back (the tab closed after signing, the network dropped) leaves the row
-- open; the social worker's claim steps (`claims/settle.ts`, as
-- `blast_watcher`, which 0085 already lets read and update the log) settle it
-- from the indexer, or mark it `expired` once it is past its time. Both scan
-- only the claims still open, oldest first: this index holds exactly those
-- rows, so its size is the claims in flight, never the log's million rows,
-- and a row leaves it the moment it settles.
--
-- No grant changes: the worker's and the web's grants on the table (0084,
-- 0085) already cover both statements, and 0084's trigger still decides
-- what may change.
CREATE INDEX social_transactions_open_claims_idx ON social_transactions (created_at_ms, tx_id)
  WHERE state = 'submitted' AND kind IN ('claim_refund', 'claim_tokens', 'claim_vesting');
