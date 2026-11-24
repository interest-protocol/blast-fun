-- Presale (T-016): sponsored gas for embedded-wallet transactions.
--
-- presale_sponsor_reservations: one row per sponsorship slot that
-- `POST /api/presale/sponsor` claimed for a Privy account. The route claims a
-- `reserving` row (no pool fields yet; `expires_at` covers the pool call plus
-- the pool's reservation), calls the gas pool with no connection held, then
-- completes the row to `reserved` with the pool fields, or closes it as
-- `reservation_failed` when the pool definitely refused. A `reserving` row
-- left by a crash or an ambiguous pool answer keeps its slot until
-- `expires_at`. Readers other than the cap must ignore `reserving` and
-- `reservation_failed` rows: the execute route refuses them. Execute moves a
-- `reserved` row through `submitted` to `executed`, `failed_execution` or
-- `unconfirmed`. Execute writes `expired` when a `reserved` row is executed
-- at or after `expires_at`; every reader still compares `expires_at` itself. `digest` is computed from `tx_bytes` at
-- completion: the sponsored path's pre-submit registration of the digest with
-- the account. Nothing here is a key, a token or a signature: the browser
-- signs `tx_bytes` and the pool signs as sponsor at execute.
CREATE TABLE presale_sponsor_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  privy_did TEXT NOT NULL CHECK (privy_did ~ '^did:privy:[A-Za-z0-9_-]{1,128}$'),
  sender TEXT NOT NULL CHECK (sender ~ '^0x[0-9a-f]{64}$'),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  intent TEXT NOT NULL CHECK (intent IN ('commit', 'claim', 'settle', 'cancel', 'reward_claim')),
  pool_reservation_id TEXT UNIQUE CHECK (pool_reservation_id ~ '^(0|[1-9][0-9]{0,19})$'),
  tx_bytes BYTEA CHECK (octet_length(tx_bytes) BETWEEN 1 AND 131072),
  digest TEXT CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  gas_budget BIGINT NOT NULL CHECK (gas_budget > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  -- When the claim's pool call has ended at the latest (claim time + pool timeout): until then a
  -- `reserving` row may still resolve, so the cap's Retry-After names it.
  pool_deadline TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserving'
    CHECK (state IN (
      'reserving', 'reservation_failed', 'reserved', 'submitted', 'executed', 'failed_execution', 'unconfirmed', 'expired'
    )),
  effects_status TEXT CHECK (effects_status IN ('success', 'failure')),
  -- Net MIST (computation + storage - rebate), which may be negative.
  gas_used BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK ((effects_status IS NULL) = (gas_used IS NULL)),
  -- Every state past the claim carries the pool reservation and the bytes it pays for, and a claim or a
  -- closed claim carries none of them.
  CHECK (
    (state IN ('reserving', 'reservation_failed'))
    = (pool_reservation_id IS NULL AND tx_bytes IS NULL AND digest IS NULL)
  ),
  CHECK (
    (pool_reservation_id IS NULL) = (tx_bytes IS NULL) AND (tx_bytes IS NULL) = (digest IS NULL)
  )
);

-- The open-reservation cap reads one account's unexpired rows.
CREATE INDEX presale_sponsor_reservations_open
  ON presale_sponsor_reservations (privy_did, expires_at)
  WHERE state IN ('reserving', 'reserved', 'submitted');
CREATE INDEX presale_sponsor_reservations_digest ON presale_sponsor_reservations (digest);

REVOKE ALL ON TABLE presale_sponsor_reservations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE presale_sponsor_reservations TO blast_web;

-- presale_sponsor_refusal_counts: `target_not_allowed` refusals per UTC hour
-- and reason (object IDs and numbers replaced by placeholders). The worker
-- host reads them for the `sponsor_target_refusals` alert, for example after a
-- Cetus aggregator upgrade.
CREATE TABLE presale_sponsor_refusal_counts (
  hour TIMESTAMPTZ NOT NULL CHECK (hour = date_trunc('hour', hour, 'UTC')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 160),
  count BIGINT NOT NULL CHECK (count > 0),
  PRIMARY KEY (hour, reason)
);

REVOKE ALL ON TABLE presale_sponsor_refusal_counts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE presale_sponsor_refusal_counts TO blast_web;
GRANT SELECT ON TABLE presale_sponsor_refusal_counts TO blast_watcher;
