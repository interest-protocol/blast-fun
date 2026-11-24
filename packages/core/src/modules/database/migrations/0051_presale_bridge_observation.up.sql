-- Presale (T-021 revision 2, review R-002 B-009/B-010): durable poll-queue
-- evidence for the bridge relayer worker, additive to 0044.
--
-- circle_not_found_at: the last time Circle answered "not found" for the
-- transfer's burn past the first minute of its observation window. It is the
-- only evidence that demotes a transfer in the relayer's queue (A-008:
-- transfers Circle has seen are polled before never-seen ones); a row without
-- it, a new registration or any row after a restart, keeps normal priority.
-- Circle answering with a message clears it.
--
-- observed_from: the start of the transfer's current observation window
-- (null: sent_at). A never-seen registration is parked 24 h into its window;
-- registering the same burn again re-arms a parked one for one more window.
--
-- The relayer worker (blast_watcher) records the evidence. The web runtime
-- (blast_web), on a repeat registration of a parked transfer, may only re-arm
-- it: next_poll_at, observed_from, and clearing the evidence.
ALTER TABLE presale_bridge_transfers
  ADD COLUMN circle_not_found_at TIMESTAMPTZ,
  ADD COLUMN observed_from TIMESTAMPTZ,
  ADD CONSTRAINT presale_bridge_transfers_observed_from_check CHECK (observed_from >= sent_at);

GRANT UPDATE (circle_not_found_at) ON TABLE presale_bridge_transfers TO blast_watcher;
GRANT UPDATE (next_poll_at, observed_from, circle_not_found_at) ON TABLE presale_bridge_transfers TO blast_web;
