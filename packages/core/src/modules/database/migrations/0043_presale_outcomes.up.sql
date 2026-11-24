-- Presale outcome registration (T-017, modules/presale/outcomes; contract
-- section 3.6). The launchpad's verified-outcome rules
-- (docs/launchpad/telemetry.md, migration 0037) applied to the presale's
-- `Committed` events: an outcome belongs to the wallet that is its event's
-- native sender, with the event's own checkpoint, time and position, whoever
-- reported it. Its links are only what the server proved: the Privy account
-- whose embedded wallet is that sender (`privy_did`), and a visitor through
-- that account's own session (`privy_session`) or through the visitor's own
-- commitment of the digest received before the checkpoint time and not
-- contested by another visitor (`signed_commitment`). A link makes the row
-- personal data, read only by the web runtime role.
CREATE TABLE presale_outcomes (
  tx_digest TEXT NOT NULL CHECK (tx_digest ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  sender_wallet TEXT NOT NULL CHECK (sender_wallet ~ '^0x[0-9a-f]{64}$'),
  checkpoint BIGINT NOT NULL CHECK (checkpoint >= 0),
  completed_at TIMESTAMPTZ NOT NULL,
  visitor_id UUID,
  visitor_link TEXT CHECK (visitor_link IN ('privy_session', 'signed_commitment')),
  privy_did TEXT CHECK (privy_did ~ '^did:privy:[A-Za-z0-9_-]{1,128}$'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_digest, event_seq),
  CONSTRAINT presale_outcomes_link_with_visitor CHECK ((visitor_id IS NULL) = (visitor_link IS NULL))
);

-- Per-sale conversion reads.
CREATE INDEX presale_outcomes_presale_idx ON presale_outcomes (presale_id, completed_at);

-- A visitor's commitment, sent by its browser just before submission, that a
-- signed transaction's digest is its own: one row per digest and visitor, with
-- the server's receipt time. A digest's commitments are deleted in the
-- transaction that records its outcome.
CREATE TABLE presale_outcome_commitments (
  tx_digest TEXT NOT NULL CHECK (tx_digest ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  visitor_id UUID NOT NULL,
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  committed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tx_digest, visitor_id)
);

CREATE INDEX presale_outcome_commitments_committed_idx ON presale_outcome_commitments (committed_at);

-- The web runtime's alone. An outcome's chain facts never change: only its
-- missing links are written later. The maintenance cleanup, which runs as the
-- web runtime, deletes outcomes after the launchpad reporting policy's
-- retention and undecided commitments after the commitment window
-- (maintenance/repository.ts). Commitments are inserted and deleted, never updated.
REVOKE ALL ON TABLE presale_outcomes FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE presale_outcomes TO blast_web;
GRANT UPDATE (visitor_id, visitor_link, privy_did) ON TABLE presale_outcomes TO blast_web;
REVOKE ALL ON TABLE presale_outcome_commitments FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE presale_outcome_commitments TO blast_web;
