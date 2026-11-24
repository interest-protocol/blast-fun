-- Presale (T-020): the CCTP bridge's transfer registry and its activation
-- records (modules/presale/bridge).
--
-- presale_bridge_transfers: one row per registered burn, unique on
-- (source, tx_hash). The web runtime inserts a row as `sent` and reads it;
-- the bridge relayer worker (blast_watcher) reads rows and advances them
-- through the repository's forward-only transitions, so it may update only
-- the progress columns, never what the user registered. Nobody deletes a
-- transfer. Nothing here is a secret: public chain data, a DID, a status.
--
-- presale_bridge_activations: the operator's activation checklist records.
-- Rows are only ever inserted, so the history stays; the newest row governs.
-- The web runtime (and the operator command) inserts and reads; the worker
-- reads.
CREATE TABLE presale_bridge_transfers (
  id TEXT PRIMARY KEY DEFAULT ('bt_' || replace(gen_random_uuid()::text, '-', ''))
    CHECK (id ~ '^bt_[0-9a-f]{32}$'),
  source TEXT NOT NULL CHECK (source IN ('ethereum', 'arbitrum', 'solana', 'base')),
  source_domain INTEGER NOT NULL,
  tx_hash TEXT NOT NULL CHECK (
    (source = 'solana' AND tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$')
    OR (source <> 'solana' AND tx_hash ~ '^0x[0-9a-f]{64}$')
  ),
  sui_address TEXT NOT NULL CHECK (sui_address ~ '^0x[0-9a-f]{64}$'),
  amount NUMERIC(20, 0) NOT NULL CHECK (amount > 0 AND amount <= 18446744073709551615),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  privy_did TEXT CHECK (privy_did ~ '^did:privy:[A-Za-z0-9_-]{1,128}$'),
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'attested', 'minted', 'failed')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attested_at TIMESTAMPTZ,
  minted_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error TEXT CHECK (char_length(error) BETWEEN 1 AND 512),
  nonce TEXT CHECK (nonce ~ '^0x[0-9a-f]{2,128}$'),
  message TEXT CHECK (message ~ '^0x([0-9a-f]{2})+$' AND char_length(message) <= 16386),
  attestation TEXT CHECK (attestation ~ '^0x([0-9a-f]{2})+$' AND char_length(attestation) <= 8194),
  sui_digest TEXT CHECK (sui_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  UNIQUE (source, tx_hash),
  CHECK (source_domain = CASE source WHEN 'ethereum' THEN 0 WHEN 'arbitrum' THEN 3 WHEN 'solana' THEN 5 WHEN 'base' THEN 6 END),
  -- Each status carries exactly the stamps of the moves that reached it.
  CHECK (
    (status = 'sent' AND attested_at IS NULL AND minted_at IS NULL AND failed_at IS NULL)
    OR (status = 'attested' AND attested_at IS NOT NULL AND minted_at IS NULL AND failed_at IS NULL)
    OR (status = 'minted' AND attested_at IS NOT NULL AND minted_at IS NOT NULL AND failed_at IS NULL AND sui_digest IS NOT NULL)
    OR (status = 'failed' AND minted_at IS NULL AND failed_at IS NOT NULL AND error IS NOT NULL)
  ),
  -- Stamps never run backwards, whatever time a caller supplies.
  CHECK (attested_at >= sent_at),
  CHECK (minted_at >= attested_at),
  CHECK (failed_at >= sent_at),
  CHECK (failed_at >= attested_at)
);

-- The relayer worker's queue, by next poll: transfers in flight, and
-- attestation timeouts that a late attestation can still revive.
CREATE INDEX presale_bridge_transfers_due ON presale_bridge_transfers (next_poll_at)
  WHERE status IN ('sent', 'attested')
    OR (status = 'failed' AND error = 'attestation_timeout' AND attested_at IS NULL);

CREATE TABLE presale_bridge_activations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL CHECK (recorded_by ~ '^operator:[A-Za-z0-9._:-]{1,128}$'),
  kind TEXT NOT NULL CHECK (kind IN ('checklist', 'deactivation')),
  forwarding TEXT CHECK (forwarding IN ('blast', 'circle')),
  relayer_address TEXT CHECK (relayer_address ~ '^0x[0-9a-f]{64}$'),
  hook_data TEXT CHECK (hook_data ~ '^0x([0-9a-f]{2})+$' AND char_length(hook_data) <= 2050),
  sui_cctp JSONB CHECK (jsonb_typeof(sui_cctp) = 'object'),
  checklist JSONB NOT NULL CHECK (jsonb_typeof(checklist) = 'object'),
  complete BOOLEAN NOT NULL,
  problems TEXT[] NOT NULL,
  CHECK ((kind = 'checklist') = (forwarding IS NOT NULL)),
  -- Only a checklist with no problem, for a mode, ids and its caller or hook, activates.
  CHECK (
    NOT complete OR (
      kind = 'checklist' AND cardinality(problems) = 0 AND sui_cctp IS NOT NULL
      AND ((forwarding = 'blast' AND relayer_address IS NOT NULL AND hook_data IS NULL)
        OR (forwarding = 'circle' AND hook_data IS NOT NULL))
    )
  ),
  CHECK (complete OR cardinality(problems) > 0)
);

REVOKE ALL ON TABLE presale_bridge_transfers FROM PUBLIC;
REVOKE ALL ON TABLE presale_bridge_activations FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE presale_bridge_transfers TO blast_web;
GRANT SELECT ON TABLE presale_bridge_transfers TO blast_watcher;
GRANT UPDATE (
  status, attested_at, minted_at, failed_at, error, nonce, message, attestation, sui_digest, next_poll_at, poll_count
) ON TABLE presale_bridge_transfers TO blast_watcher;
GRANT SELECT, INSERT ON TABLE presale_bridge_activations TO blast_web;
GRANT SELECT ON TABLE presale_bridge_activations TO blast_watcher;
