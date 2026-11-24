-- Social feed R3-31: the swap path. Trading is in scope (OA-25 Q1) and swaps
-- are routed by the Cetus aggregator (Q11). A trade starts from a quote R3-30
-- offered (a sealed `quote_id` that pins the account, the Blast wallet, the
-- amounts, the slippage and the route's pools in order) and is one row here
-- per (account, idempotency key): the attempt, what was built for the wallet
-- to sign, and how it ended. A replayed key answers this row and never builds
-- a second transaction.
--
-- A refused attempt (the quote expired, the price moved past its slippage,
-- the wallet is short, the pool is gone) is a `failed` row with its published
-- code and no bytes. A built one holds the transaction bytes the wallet signs
-- and their digest, who pays the network fee (`blast`: Blast's gas pool, for
-- an embedded wallet within the daily cap; `wallet`: the wallet itself, OA-17)
-- and, for `blast`, the sponsor's reservation. It settles from the chain to
-- `confirmed` with the amount that filled, or `failed`, never anything else.
-- Every row is also logged in `social_transactions` (R3-27) as `trade_buy` or
-- `trade_sell`, with the same id, in the same transaction.
--
-- The facts of a row are never edited and a row is never deleted: the web
-- runtime inserts and settles rows and has no DELETE, and a trigger refuses,
-- for every role including the migration login, any update that touches
-- anything but `state`, `failure_code`, `amount_out_filled` and
-- `settled_at_ms` (0080's pattern), or that moves a settled row.
-- Personal data: no replica grant, read on the primary only.
CREATE TABLE social_swap_intents (
  trade_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  -- The client's key for this trade (a UUID v4), unique per account.
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  -- SHA-256 of the quote id the first request carried: a replay must carry the same one.
  quote_digest BYTEA NOT NULL CHECK (octet_length(quote_digest) = 32),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  sender TEXT NOT NULL CHECK (sender ~ '^0x[0-9a-f]{64}$'),
  in_coin TEXT NOT NULL CHECK (char_length(in_coin) BETWEEN 8 AND 512),
  out_coin TEXT NOT NULL CHECK (char_length(out_coin) BETWEEN 8 AND 512),
  amount_in NUMERIC(20, 0) NOT NULL CHECK (amount_in > 0 AND amount_in <= 18446744073709551615),
  amount_out NUMERIC(20, 0) NOT NULL CHECK (amount_out > 0 AND amount_out <= 18446744073709551615),
  min_out NUMERIC(20, 0) NOT NULL CHECK (min_out >= 0 AND min_out <= amount_out),
  slippage_bps INTEGER NOT NULL CHECK (slippage_bps BETWEEN 1 AND 500),
  -- The pinned legs in execution order: pool, venue, coins and amounts, as quoted.
  route JSONB NOT NULL CHECK (jsonb_typeof(route) = 'array' AND jsonb_array_length(route) BETWEEN 1 AND 8),
  -- The gate's route string for those legs, as the quote showed it.
  route_label TEXT CHECK (char_length(route_label) BETWEEN 1 AND 300),
  quote_expires_at_ms BIGINT NOT NULL CHECK (quote_expires_at_ms > 0),
  usd_value NUMERIC(20, 2) CHECK (usd_value >= 0),
  fee_payer TEXT CHECK (fee_payer IN ('blast', 'wallet')),
  reservation_id UUID,
  tx_bytes BYTEA CHECK (octet_length(tx_bytes) BETWEEN 1 AND 131072),
  digest TEXT CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- After this, built bytes the chain never showed settle as `expired`.
  expires_at_ms BIGINT,
  state TEXT NOT NULL CHECK (state IN ('built', 'confirmed', 'failed')),
  -- A published code's shape: lowercase words, so no raw chain error string fits.
  failure_code TEXT CHECK (failure_code ~ '^[a-z][a-z0-9_]{2,63}$'),
  amount_out_filled NUMERIC(20, 0) CHECK (amount_out_filled >= 0 AND amount_out_filled <= 18446744073709551615),
  created_at_ms BIGINT NOT NULL DEFAULT (extract(epoch FROM now()) * 1000)::bigint CHECK (created_at_ms > 0),
  settled_at_ms BIGINT,
  CONSTRAINT social_swap_intents_key UNIQUE (account_id, idempotency_key),
  CONSTRAINT social_swap_intents_coins CHECK (in_coin <> out_coin),
  -- Built exactly when it holds what the wallet signs; settled exactly when not built.
  CONSTRAINT social_swap_intents_built CHECK (
    (tx_bytes IS NOT NULL) = (digest IS NOT NULL)
    AND (tx_bytes IS NOT NULL) = (fee_payer IS NOT NULL)
    AND (tx_bytes IS NOT NULL) = (expires_at_ms IS NOT NULL)
    AND (state <> 'built' OR tx_bytes IS NOT NULL)
  ),
  CONSTRAINT social_swap_intents_sponsored CHECK (reservation_id IS NULL OR fee_payer = 'blast'),
  CONSTRAINT social_swap_intents_settled CHECK ((state = 'built') = (settled_at_ms IS NULL)),
  CONSTRAINT social_swap_intents_failure CHECK ((state = 'failed') = (failure_code IS NOT NULL)),
  -- Confirmed only from the chain: a digest and what filled, never below the minimum.
  CONSTRAINT social_swap_intents_confirmed CHECK (
    state <> 'confirmed' OR (digest IS NOT NULL AND amount_out_filled IS NOT NULL AND amount_out_filled >= min_out)
  ),
  CONSTRAINT social_swap_intents_settled_after CHECK (settled_at_ms IS NULL OR settled_at_ms >= created_at_ms)
);

-- The daily sponsorship cap: an account's sponsored trades since a time (the
-- UTC day's start), excluding the ones that failed.
CREATE INDEX social_swap_intents_sponsored_idx ON social_swap_intents (account_id, created_at_ms)
  WHERE fee_payer = 'blast' AND state <> 'failed';
-- One trade per transaction on chain.
CREATE UNIQUE INDEX social_swap_intents_digest_idx ON social_swap_intents (digest) WHERE digest IS NOT NULL;

CREATE FUNCTION social_swap_intents_check_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Every column but the four that record the outcome is the row's facts, including any added later.
  IF (to_jsonb(NEW) - ARRAY['state', 'failure_code', 'amount_out_filled', 'settled_at_ms'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'failure_code', 'amount_out_filled', 'settled_at_ms']) THEN
    RAISE EXCEPTION 'a trade''s facts are never edited'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_swap_intents_never_edited';
  END IF;
  -- A settled trade is final.
  IF OLD.state <> 'built' AND (
    NEW.state IS DISTINCT FROM OLD.state
    OR NEW.failure_code IS DISTINCT FROM OLD.failure_code
    OR NEW.amount_out_filled IS DISTINCT FROM OLD.amount_out_filled
    OR NEW.settled_at_ms IS DISTINCT FROM OLD.settled_at_ms
  ) THEN
    RAISE EXCEPTION 'a settled trade never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_swap_intents_settled_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_swap_intents_immutable
BEFORE UPDATE ON social_swap_intents
FOR EACH ROW EXECUTE FUNCTION social_swap_intents_check_update();

-- The web runtime records and settles trades; nothing deletes one.
REVOKE ALL ON TABLE social_swap_intents FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_swap_intents TO blast_web;

-- The presale sponsor's `trade` intent (as 0074 added `withdraw`): the social
-- swap path sponsors an embedded wallet's swap in-process, with a kind it
-- built from the pinned quote; `evaluateTradePolicy` checks it. A trade acts
-- on no presale, so its reservation names none. The sponsor's HTTP route
-- still takes only the presale intents and `withdraw`.
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit', 'claim', 'settle', 'cancel', 'reward_claim', 'withdraw', 'trade'));
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw', 'trade')));
