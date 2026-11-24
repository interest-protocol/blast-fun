-- Verified outcome attribution (modules/launchpad-telemetry,
-- docs/launchpad/telemetry.md). An outcome belongs to the wallet that is its
-- completed event's native `sender`, with the event's own checkpoint, time
-- and position, whoever reported it. A visitor is linked to it only by the
-- visitor's own verified Privy session for that wallet (`privy_session`) or
-- the visitor's own commitment of the transaction's digest received before
-- its checkpoint (`signed_commitment`); otherwise the outcome is wallet-only.
-- The sender is public chain data; a link makes the row personal data, read
-- only by the web runtime role.
ALTER TABLE mission_control_launchpad_outcomes
  ADD COLUMN sender_wallet TEXT CHECK (sender_wallet ~ '^0x[0-9a-f]{64}$'),
  ADD COLUMN visitor_link TEXT CHECK (visitor_link IN ('privy_session', 'signed_commitment'));

-- Required for every row recorded from now on. NOT VALID leaves development
-- rows recorded before this migration as they are (no deployment is released,
-- so no production row exists).
ALTER TABLE mission_control_launchpad_outcomes
  ADD CONSTRAINT mission_control_launchpad_outcomes_sender_required
    CHECK (sender_wallet IS NOT NULL) NOT VALID,
  ADD CONSTRAINT mission_control_launchpad_outcomes_link_with_visitor
    CHECK ((visitor_id IS NULL) = (visitor_link IS NULL)) NOT VALID;

-- Per-wallet repeat-trading queries.
CREATE INDEX mission_control_launchpad_outcomes_sender_idx
  ON mission_control_launchpad_outcomes (sender_wallet, kind, completed_at);

-- A visitor's commitment, sent by its browser just before submission, that a
-- signed transaction's digest is its own: one row per digest and visitor, with
-- the server's receipt time. A digest's commitments are deleted in the
-- transaction that decides its outcome's link; the maintenance cleanup deletes
-- any never decided after a short configured window.
CREATE TABLE mission_control_launchpad_outcome_commitments (
  tx_digest TEXT NOT NULL CHECK (tx_digest ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  visitor_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('launch', 'buy')),
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tx_digest, visitor_id)
);

CREATE INDEX mission_control_launchpad_outcome_commitments_committed_idx
  ON mission_control_launchpad_outcome_commitments (committed_at);

-- The web runtime's alone (0030): commitments are inserted once and deleted, never updated.
REVOKE ALL ON TABLE mission_control_launchpad_outcome_commitments FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE mission_control_launchpad_outcome_commitments TO blast_web;
