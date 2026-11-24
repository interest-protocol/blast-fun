-- Withdraw to another chain (the coins sheet's Withdraw USDC, "To another
-- chain"): USDC in an account's Blast wallet on Sui is burned with Circle's
-- CCTP V2 and minted on Base, Arbitrum, Ethereum or Solana by Circle's
-- Forwarding Service. One row per (account, idempotency key): the attempt,
-- the burn built for the Blast wallet to sign, and how it ended. A replayed
-- key answers this row and never builds a second burn.
--
-- A refused attempt (the wallet held less USDC, the burn failed its dry run)
-- is a `failed` row with its published code and no bytes. A built one holds
-- the transaction bytes the wallet signs and their digest, who pays the Sui
-- network fee (`blast`: Blast's gas pool for an embedded wallet; `wallet`:
-- the wallet itself, OA-17) and, for `blast`, the sponsor's reservation. It
-- settles from Sui to `burned` (the burn executed as this withdrawal) or
-- `failed` (it aborted, executed as something else, or never executed before
-- its bytes expired); a burned one becomes `delivered` once Circle reports
-- its mint on the destination, with that transaction's hash. A burned
-- withdrawal never fails: Circle mints it. Every row is also logged in
-- `social_transactions` (R3-27) as `withdraw`, in the same transaction.
--
-- The facts of a row are never edited and a row is never deleted: the web
-- runtime inserts and settles rows and has no DELETE, and a trigger refuses,
-- for every role including the migration login, any update that touches
-- anything but `state`, `failure_code`, `destination_tx_hash`, `burned_at_ms`
-- and `delivered_at_ms` (0089's pattern), or that moves a row backwards.
-- Personal data: no replica grant, read on the primary only.
CREATE TABLE social_bridge_withdrawals (
  withdrawal_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  -- The client's key for this withdrawal (a UUID v4), unique per account.
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  -- The Blast wallet the USDC leaves.
  sender TEXT NOT NULL CHECK (sender ~ '^0x[0-9a-f]{64}$'),
  destination TEXT NOT NULL CHECK (destination IN ('base', 'arbitrum', 'ethereum', 'solana')),
  -- The reader's address there: an EVM address in lowercase, or a Solana key in base58.
  recipient TEXT NOT NULL,
  -- The burn's 32-byte mint recipient: the EVM address left-padded, or the Solana key's USDC token account.
  mint_recipient TEXT NOT NULL CHECK (mint_recipient ~ '^0x[0-9a-f]{64}$' AND mint_recipient <> '0x0000000000000000000000000000000000000000000000000000000000000000'),
  -- USDC atoms burned on Sui.
  amount NUMERIC(20, 0) NOT NULL CHECK (amount > 0 AND amount <= 18446744073709551615),
  -- What Circle may keep on the destination (and does: it keeps all of it), strictly below the amount.
  max_fee NUMERIC(20, 0) NOT NULL CHECK (max_fee >= 0 AND max_fee < amount),
  -- The Forwarding Service's hook the burn carries: 32 bytes, or 65 for Solana's account setup.
  hook BYTEA NOT NULL,
  fee_payer TEXT CHECK (fee_payer IN ('blast', 'wallet')),
  reservation_id UUID,
  tx_bytes BYTEA CHECK (octet_length(tx_bytes) BETWEEN 1 AND 131072),
  digest TEXT CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- After this, built bytes Sui never showed settle as `expired`.
  expires_at_ms BIGINT,
  state TEXT NOT NULL CHECK (state IN ('built', 'burned', 'delivered', 'failed')),
  failure_code TEXT CHECK (failure_code IN ('insufficient_balance', 'dry_run_failed', 'execution_failed', 'mismatch', 'expired')),
  -- The destination's mint as Circle reports it: an EVM transaction hash in lowercase, or a Solana signature.
  destination_tx_hash TEXT,
  created_at_ms BIGINT NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint CHECK (created_at_ms > 0),
  burned_at_ms BIGINT,
  delivered_at_ms BIGINT,
  CONSTRAINT social_bridge_withdrawals_key UNIQUE (account_id, idempotency_key),
  CONSTRAINT social_bridge_withdrawals_recipient CHECK (
    CASE WHEN destination = 'solana' THEN recipient ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
      ELSE recipient ~ '^0x[0-9a-f]{40}$' AND recipient <> '0x0000000000000000000000000000000000000000' END
  ),
  CONSTRAINT social_bridge_withdrawals_hook CHECK (octet_length(hook) = CASE WHEN destination = 'solana' THEN 65 ELSE 32 END),
  -- Bytes exactly with their digest, payer and expiry; a sponsored one names its reservation.
  CONSTRAINT social_bridge_withdrawals_built CHECK (
    (tx_bytes IS NOT NULL) = (digest IS NOT NULL)
    AND (tx_bytes IS NOT NULL) = (fee_payer IS NOT NULL)
    AND (tx_bytes IS NOT NULL) = (expires_at_ms IS NOT NULL)
  ),
  CONSTRAINT social_bridge_withdrawals_sponsored CHECK (reservation_id IS NULL OR fee_payer = 'blast'),
  CONSTRAINT social_bridge_withdrawals_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  -- Refused before anything was built exactly when it holds no bytes; everything else was built.
  CONSTRAINT social_bridge_withdrawals_refused CHECK (
    (tx_bytes IS NULL) = (state = 'failed' AND failure_code IN ('insufficient_balance', 'dry_run_failed'))
  ),
  CONSTRAINT social_bridge_withdrawals_burned CHECK ((burned_at_ms IS NOT NULL) = (state IN ('burned', 'delivered'))),
  -- Delivered only on Circle's word: the destination's hash and when it was seen.
  CONSTRAINT social_bridge_withdrawals_delivered CHECK (
    (state = 'delivered') = (destination_tx_hash IS NOT NULL)
    AND (state = 'delivered') = (delivered_at_ms IS NOT NULL)
  ),
  CONSTRAINT social_bridge_withdrawals_destination_tx CHECK (
    destination_tx_hash IS NULL
    OR CASE WHEN destination = 'solana' THEN destination_tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'
      ELSE destination_tx_hash ~ '^0x[0-9a-f]{64}$' END
  ),
  CONSTRAINT social_bridge_withdrawals_times CHECK (
    (burned_at_ms IS NULL OR burned_at_ms >= created_at_ms)
    AND (delivered_at_ms IS NULL OR delivered_at_ms >= burned_at_ms)
  )
);

-- One withdrawal per transaction on chain.
CREATE UNIQUE INDEX social_bridge_withdrawals_digest_idx ON social_bridge_withdrawals (digest) WHERE digest IS NOT NULL;

CREATE FUNCTION social_bridge_withdrawals_check_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Every column but the five that record the outcome is the row's facts, including any added later.
  IF (to_jsonb(NEW) - ARRAY['state', 'failure_code', 'destination_tx_hash', 'burned_at_ms', 'delivered_at_ms'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'failure_code', 'destination_tx_hash', 'burned_at_ms', 'delivered_at_ms']) THEN
    RAISE EXCEPTION 'a withdrawal''s facts are never edited'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_bridge_withdrawals_never_edited';
  END IF;
  -- Forward only: built to burned or failed, burned to delivered; delivered and failed are final.
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'built' AND NEW.state IN ('burned', 'failed'))
    OR (OLD.state = 'burned' AND NEW.state = 'delivered')
  ) THEN
    RAISE EXCEPTION 'a withdrawal only moves forward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_bridge_withdrawals_forward';
  END IF;
  -- What a state recorded stays as it was recorded.
  IF NEW.state IS NOT DISTINCT FROM OLD.state AND (
    NEW.failure_code IS DISTINCT FROM OLD.failure_code
    OR NEW.destination_tx_hash IS DISTINCT FROM OLD.destination_tx_hash
    OR NEW.burned_at_ms IS DISTINCT FROM OLD.burned_at_ms
    OR NEW.delivered_at_ms IS DISTINCT FROM OLD.delivered_at_ms
  ) THEN
    RAISE EXCEPTION 'a withdrawal only moves forward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_bridge_withdrawals_forward';
  END IF;
  IF OLD.burned_at_ms IS NOT NULL AND NEW.burned_at_ms IS DISTINCT FROM OLD.burned_at_ms THEN
    RAISE EXCEPTION 'a withdrawal only moves forward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_bridge_withdrawals_forward';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_bridge_withdrawals_immutable
BEFORE UPDATE ON social_bridge_withdrawals
FOR EACH ROW EXECUTE FUNCTION social_bridge_withdrawals_check_update();

-- The web runtime records and settles withdrawals; nothing deletes one.
REVOKE ALL ON TABLE social_bridge_withdrawals FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_bridge_withdrawals TO blast_web;

-- The presale sponsor's `bridge_withdraw` intent (as 0089 added `trade`): the
-- withdrawal route sponsors an embedded wallet's burn in-process, with a kind
-- it built itself; `evaluateBridgeWithdrawPolicy` checks it. A withdrawal acts
-- on no presale, so its reservation names none. The sponsor's HTTP route
-- still takes only the presale intents and `withdraw`.
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit', 'claim', 'settle', 'cancel', 'reward_claim', 'withdraw', 'trade', 'bridge_withdraw'));
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw', 'trade', 'bridge_withdraw')));
