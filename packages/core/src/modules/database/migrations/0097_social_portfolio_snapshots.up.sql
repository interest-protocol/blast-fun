-- Social feed OA-25 Q16 (R3-08's trend, R3-20's scope): a daily
-- portfolio-value snapshot per account, written by the social worker
-- (`portfolio/snapshots.ts`, role `blast_watcher`), so the gold card's
-- `30 days +18%` is a sentence about what the account actually held each day
-- and never today's holdings at old prices. The card's trend slot stays empty
-- until an account has a month of them (`portfolio/trend.ts`).
--
-- One row per (account, UTC day). Once per UTC day, on the chain's clock
-- (the slower pipeline's watermark time), the worker values each account
-- that has a wallet: its open and closed presale commitments (Committed),
-- its commitments in sales it can claim from (Claimable), the sale coins its
-- wallets hold (Tokens) — all three from `chain_read_v1` — and the USDC and
-- SUI in its wallets, from the fullnode as the portfolio reads them. Every
-- amount is priced at that moment's `chain_read_v1.prices` row (USDC at face
-- value, as the card counts it); the parts are exact decimals rounded to
-- cents once, and `value_usd` is their sum. The row keeps the five parts,
-- the chain time and checkpoint the holdings were read at, and the oldest
-- price it used: enough to say what a day's figure was made of.
--
-- A day that cannot be valued — a held coin without a price at most 15
-- minutes old, or the fullnode not answering — is a row with no figures and
-- the reason in `skipped`, never a partial or estimated value. The worker
-- retries skipped rows during the same UTC day; a valued row is never
-- changed (the trigger refuses it). A day the worker never reached has no
-- row: holdings are read as they are, so a missed day is never backfilled.
--
-- An opted-in public portfolio (OA-10) shows only the days since it became
-- public (`social_accounts.portfolio_public_since`, below).
--
-- Reads: the trend is one account's newest days, `(account_id, day)` the
-- key, newest first, keyset on `day`; `value_usd` is in the key's index so
-- the read never touches the heap. The worker's retry pass reads one day's
-- skipped rows through the partial index, whose size is the day's skips.
-- Retention: the worker deletes an account's rows older than
-- `SOCIAL_PORTFOLIO_SNAPSHOT_RETENTION_DAYS` (400 by default) as it writes
-- the account's new day, a range of the same key.
CREATE TABLE social_portfolio_snapshots (
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  -- The UTC day of `taken_at_ms`.
  day DATE NOT NULL,
  -- USD, the sum of the five parts; null exactly when the day was skipped.
  value_usd NUMERIC(20, 2) CHECK (value_usd >= 0),
  committed_usd NUMERIC(20, 2) CHECK (committed_usd >= 0),
  claimable_usd NUMERIC(20, 2) CHECK (claimable_usd >= 0),
  tokens_usd NUMERIC(20, 2) CHECK (tokens_usd >= 0),
  usdc_usd NUMERIC(20, 2) CHECK (usdc_usd >= 0),
  sui_usd NUMERIC(20, 2) CHECK (sui_usd >= 0),
  skipped TEXT CHECK (skipped IN ('price_missing', 'balances_unavailable')),
  -- The chain clock (the slower pipeline's watermark time) and that watermark's checkpoint when the holdings were read.
  taken_at_ms BIGINT NOT NULL CHECK (taken_at_ms >= 0),
  checkpoint BIGINT NOT NULL CHECK (checkpoint >= 0),
  -- The oldest `as_of_ms` of the prices the value used; null when it used none (or was skipped).
  prices_as_of_ms BIGINT CHECK (prices_as_of_ms >= 0),
  CONSTRAINT social_portfolio_snapshots_pkey PRIMARY KEY (account_id, day) INCLUDE (value_usd),
  CONSTRAINT social_portfolio_snapshots_day CHECK (day = DATE '1970-01-01' + (taken_at_ms / 86400000)::integer),
  CONSTRAINT social_portfolio_snapshots_valued CHECK (
    (skipped IS NULL) = (value_usd IS NOT NULL)
    AND num_nulls(value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd) IN (0, 6)
    AND (value_usd IS NULL OR value_usd = committed_usd + claimable_usd + tokens_usd + usdc_usd + sui_usd)
    AND (value_usd IS NOT NULL OR prices_as_of_ms IS NULL)
  )
);

-- The worker's retry pass: one day's skipped rows, keyset on the account.
CREATE INDEX social_portfolio_snapshots_skipped_idx ON social_portfolio_snapshots (day, account_id)
  WHERE skipped IS NOT NULL;

-- A valued day is a fact: only a skipped row may be replaced (by a later
-- attempt the same day), and only by a row of the same account and day.
CREATE FUNCTION social_portfolio_snapshots_check_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.skipped IS NULL OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.day IS DISTINCT FROM OLD.day THEN
    RAISE EXCEPTION 'a valued portfolio snapshot never changes'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_portfolio_snapshots_valued_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_portfolio_snapshots_final
BEFORE UPDATE ON social_portfolio_snapshots
FOR EACH ROW EXECUTE FUNCTION social_portfolio_snapshots_check_update();

-- The watcher writes, retries and expires them; the web runtime reads the
-- owner's on the primary (`/me/portfolio`) and the replica reads an opted-in
-- public portfolio's (OA-10), both through `portfolio/trend.ts`.
REVOKE ALL ON TABLE social_portfolio_snapshots FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE social_portfolio_snapshots TO blast_watcher;
GRANT SELECT ON TABLE social_portfolio_snapshots TO blast_web, blast_replica;

-- The owner's answer (2026-10-06): a public portfolio's trend shows only the
-- days since its owner made it public, and a newly public portfolio has no
-- line until it has a month of public history; the owner's own view keeps
-- the whole history. `portfolio_public_since` is when the portfolio last
-- became visible to others — the "Public portfolio" switch (0059) on while
-- the account is public — and null while it is not. The trigger keeps it so
-- for every writer (Settings, onboarding, the operator CLI): it starts at the
-- transaction's time when the portfolio becomes visible, stays while it
-- stays visible, and is cleared when the switch goes off or the account goes
-- private, so opting in again starts a new public history. Existing visible
-- portfolios start now: no day before this migration is ever shown publicly.
-- The replica reads it with the rest of the row (0054's table grant).
ALTER TABLE social_accounts ADD COLUMN portfolio_public_since TIMESTAMPTZ;
UPDATE social_accounts SET portfolio_public_since = now() WHERE portfolio_public AND privacy = 'public';
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_portfolio_public_since
  CHECK ((portfolio_public AND privacy = 'public') = (portfolio_public_since IS NOT NULL));

CREATE FUNCTION social_accounts_set_portfolio_public_since()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (NEW.portfolio_public AND NEW.privacy = 'public') THEN
    NEW.portfolio_public_since := NULL;
  ELSIF TG_OP = 'INSERT' OR NOT (OLD.portfolio_public AND OLD.privacy = 'public') THEN
    NEW.portfolio_public_since := COALESCE(NEW.portfolio_public_since, now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_accounts_portfolio_public_since
BEFORE INSERT OR UPDATE OF portfolio_public, privacy, portfolio_public_since ON social_accounts
FOR EACH ROW EXECUTE FUNCTION social_accounts_set_portfolio_public_since();
