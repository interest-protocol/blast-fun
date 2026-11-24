-- Social feed UI-14 (canonical UI §14.2 and the live design's coins sheet):
-- the audit record of every withdrawal from an account's Blast wallet.
--
-- The coins sheet picks `request_id` (a UUID) before anything is signed and
-- records the intent here first (`pending`), so a retried tap, a reload or a
-- second tab finds the same withdrawal instead of sending again. After the
-- wallet signs and the transaction executes, the sheet adds its digest
-- (`submitted`); the server then reads the transaction from a fullnode and
-- settles the row: `confirmed` when it succeeded, was sent by `sender` and
-- moved exactly `amount` of `coin_type` to `recipient`, else `failed` with a
-- fixed reason. A digest is recorded once and never replaced.
--
-- `sender` is the account's Blast wallet (a Privy embedded wallet, whose
-- network fee Blast's gas pool pays, or the Slush address of a wallet
-- session, which pays its own). Nothing here is a key, a token or a
-- signature. Addresses stay in this table: logs and metrics never carry them.
CREATE TABLE social_coin_transfers (
  request_id UUID PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  sender TEXT NOT NULL CHECK (sender ~ '^0x[0-9a-f]{64}$'),
  recipient TEXT NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{64}$'),
  coin_type TEXT NOT NULL CHECK (char_length(coin_type) BETWEEN 8 AND 512),
  amount NUMERIC(20, 0) NOT NULL CHECK (amount > 0 AND amount <= 18446744073709551615),
  -- How the network fee is paid: Blast's gas pool (embedded wallet) or the wallet itself.
  fee TEXT NOT NULL CHECK (fee IN ('sponsored', 'wallet')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed')),
  digest TEXT UNIQUE CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  failure TEXT CHECK (failure IN ('execution_failed', 'mismatch')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ,
  -- A pending row has no digest yet; every later state carries one.
  CHECK ((status = 'pending') = (digest IS NULL)),
  CHECK ((status = 'failed') = (failure IS NOT NULL)),
  CHECK ((status IN ('confirmed', 'failed')) = (settled_at IS NOT NULL))
);

-- An account's withdrawals, newest first (a history read and the per-account audit).
CREATE INDEX social_coin_transfers_account_idx ON social_coin_transfers (account_id, created_at DESC, request_id DESC);

-- The web runtime records and settles withdrawals; nothing deletes them.
REVOKE ALL ON TABLE social_coin_transfers FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_coin_transfers TO blast_web;
