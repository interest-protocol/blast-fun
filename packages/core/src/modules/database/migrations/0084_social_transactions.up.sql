-- Social feed R3-27: the per-account transaction log. Every money action the
-- product sends for an account (a commit, a claim, a deposit, a withdrawal
-- and, if trading opens, a trade) is one row here, written by the path that
-- sends it through one helper (`src/modules/social/transactions/log.ts`), in
-- the same transaction as that path's own write where it has one. The
-- wallet's "This session" list (R3-58) and every toast's explorer link read
-- it through GET /api/social/me/transactions.
--
-- What it is not: a copy of chain data. It holds what Blast sent and what
-- became of it; `chain_read_v1.activity` stays the authority for what the
-- chain did. A withdrawal's own state machine stays `social_coin_transfers`
-- (0075); a withdrawal's row here has that request's id as its `tx_id`, so
-- the two join on the primary key, and on `digest` once there is one.
--
-- `tx_id` is the product's own id, so a row exists before a digest does: a
-- sponsored transaction's digest can arrive late or never. `state` moves
-- `submitted` to `confirmed` or `failed` and nothing else. A failed row names
-- a published code (`failure_code`), never a raw chain error string. Amounts
-- are atoms; `usd_value` is the figure at submission, when it was known.
--
-- The facts of a row are never edited and a row is never deleted: the web
-- runtime inserts and settles rows and has no DELETE, and a trigger refuses,
-- for every role including the migration login, any update that touches
-- anything but `state`, `digest`, `settled_at_ms` and `failure_code` (0080's
-- pattern), or that moves a settled row or replaces a recorded digest.
-- Personal data: no replica grant, read on the primary only.
CREATE TABLE social_transactions (
  tx_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  kind TEXT NOT NULL CHECK (kind IN (
    'commit', 'claim_refund', 'claim_tokens', 'claim_vesting', 'deposit', 'withdraw', 'trade_buy', 'trade_sell'
  )),
  state TEXT NOT NULL DEFAULT 'submitted' CHECK (state IN ('submitted', 'confirmed', 'failed')),
  digest TEXT CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  presale_id TEXT CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  coin_type TEXT CHECK (char_length(coin_type) BETWEEN 8 AND 512),
  amount NUMERIC(20, 0) CHECK (amount >= 0 AND amount <= 18446744073709551615),
  quote_type TEXT CHECK (char_length(quote_type) BETWEEN 8 AND 512),
  quote_amount NUMERIC(20, 0) CHECK (quote_amount >= 0 AND quote_amount <= 18446744073709551615),
  usd_value NUMERIC(20, 2) CHECK (usd_value >= 0),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  created_at_ms BIGINT NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint CHECK (created_at_ms > 0),
  settled_at_ms BIGINT,
  -- A published code's shape: lowercase words, so no raw chain error string fits.
  failure_code TEXT CHECK (failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  -- The same write twice logs once.
  CONSTRAINT social_transactions_idempotency_key UNIQUE (account_id, idempotency_key),
  -- An amount names its coin.
  CONSTRAINT social_transactions_amount_coin CHECK (amount IS NULL OR coin_type IS NOT NULL),
  CONSTRAINT social_transactions_quote_coin CHECK (quote_amount IS NULL OR quote_type IS NOT NULL),
  -- Settled exactly when confirmed or failed; failed exactly when it names a code; confirmed only with a digest.
  CONSTRAINT social_transactions_settled CHECK ((state = 'submitted') = (settled_at_ms IS NULL)),
  CONSTRAINT social_transactions_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  CONSTRAINT social_transactions_confirmed_digest CHECK (state <> 'confirmed' OR digest IS NOT NULL),
  CONSTRAINT social_transactions_settled_after CHECK (settled_at_ms IS NULL OR settled_at_ms >= created_at_ms)
);

-- The list: an account's rows newest first, keyset on (created_at_ms, tx_id).
CREATE INDEX social_transactions_account_idx ON social_transactions (account_id, created_at_ms DESC, tx_id);
-- One row per transaction on chain.
CREATE UNIQUE INDEX social_transactions_digest_idx ON social_transactions (digest) WHERE digest IS NOT NULL;

CREATE FUNCTION social_transactions_check_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Every column but the four that record progress is the row's facts, including any added later.
  IF (to_jsonb(NEW) - ARRAY['state', 'digest', 'settled_at_ms', 'failure_code'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'digest', 'settled_at_ms', 'failure_code']) THEN
    RAISE EXCEPTION 'a logged transaction''s facts are never edited'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_transactions_never_edited';
  END IF;
  -- A settled row is final.
  IF OLD.state <> 'submitted' AND (
    NEW.state IS DISTINCT FROM OLD.state
    OR NEW.digest IS DISTINCT FROM OLD.digest
    OR NEW.settled_at_ms IS DISTINCT FROM OLD.settled_at_ms
    OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
  ) THEN
    RAISE EXCEPTION 'a settled transaction never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_transactions_settled_final';
  END IF;
  -- A digest is recorded once and never replaced or removed.
  IF OLD.digest IS NOT NULL AND NEW.digest IS DISTINCT FROM OLD.digest THEN
    RAISE EXCEPTION 'a transaction''s digest is never replaced'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_transactions_digest_once';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_transactions_immutable
BEFORE UPDATE ON social_transactions
FOR EACH ROW EXECUTE FUNCTION social_transactions_check_update();

-- The web runtime logs and settles rows; nothing deletes one.
REVOKE ALL ON TABLE social_transactions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_transactions TO blast_web;
